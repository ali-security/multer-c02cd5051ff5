var is = require('type-is')
var Busboy = require('busboy')
var extend = require('xtend')
var appendField = require('append-field')

var Counter = require('./counter')
var MulterError = require('./multer-error')
var FileAppender = require('./file-appender')
var removeUploadedFiles = require('./remove-uploaded-files')

// append-field turns a bracket group whose contents are all digits into an
// array index, so `a[3]` produces an array of length 4. The index itself is
// unbounded, which means a single field name can materialize a sparse array
// with a very large length. That costs append-field almost nothing, but it is
// the application that pays when it later iterates or serializes req.body, and
// until now there was no limit to opt into.
function exceedsArrayIndexLimit (fieldname, limit) {
  // Only field names append-field parses as a bracket path build an array;
  // names it stores as a literal key (e.g. a[6]suffix, [6]) never do, so they
  // must not be rejected by the index limit.
  if (!/^[^[]+(?:\[[^\]]+\])*(?:\[\])?$/.test(fieldname)) return false

  var pattern = /\[(\d+)\]/g
  var match

  while ((match = pattern.exec(fieldname)) !== null) {
    if (Number(match[1]) > limit) return true
  }

  return false
}

function drainStream (stream) {
  stream.on('readable', function () {
    while (stream.read() !== null) {}
  })
}

function makeMiddleware (setup) {
  return function multerMiddleware (req, res, next) {
    if (!is(req, ['multipart'])) return next()

    var options = setup()

    var limits = options.limits
    var storage = options.storage
    var fileFilter = options.fileFilter
    var fileStrategy = options.fileStrategy
    var preservePath = options.preservePath

    req.body = Object.create(null)

    var busboy
    var appender = null
    var isDone = false
    var readFinished = false
    var errorOccured = false
    var pendingWrites = new Counter()
    var uploadedFiles = []

    function done (err) {
      if (isDone) return
      isDone = true
      if (busboy) {
        req.unpipe(busboy)
        setImmediate(() => {
          busboy.removeAllListeners()
        })
      }
      drainStream(req)
      req.resume()
      next(err)
    }

    function indicateDone () {
      if (readFinished && pendingWrites.isZero() && !errorOccured) done()
    }

    function abortWithError (uploadError) {
      if (errorOccured) return
      errorOccured = true

      pendingWrites.onceZero(function () {
        function remove (file, cb) {
          storage._removeFile(req, file, cb)
        }

        removeUploadedFiles(uploadedFiles, remove, function (err, storageErrors) {
          if (err) return done(err)

          uploadError.storageErrors = storageErrors
          done(uploadError)
        })
      })
    }

    function abortWithCode (code, optionalField) {
      abortWithError(new MulterError(code, optionalField))
    }

    function handleRequestFailure (err) {
      if (isDone) return
      if (busboy) busboy.destroy(err)
      abortWithError(err)
    }

    req.on('error', function (err) {
      handleRequestFailure(err || new Error('Request error'))
    })

    req.on('aborted', function () {
      handleRequestFailure(new Error('Request aborted'))
    })

    req.on('close', function () {
      if (req.readableEnded) return
      handleRequestFailure(new Error('Request closed'))
    })

    try {
      busboy = Busboy({
        headers: req.headers,
        limits: limits,
        preservePath: preservePath
      })
    } catch (err) {
      // next(err) is the final outcome; keep the request listeners above from
      // reporting a later abort/close of this same request a second time
      isDone = true
      return next(err)
    }

    appender = new FileAppender(fileStrategy, req)

    // handle text field data
    busboy.on('field', function (fieldname, value, { nameTruncated, valueTruncated }) {
      if (fieldname == null) return abortWithCode('MISSING_FIELD_NAME')
      if (nameTruncated) return abortWithCode('LIMIT_FIELD_KEY')
      if (valueTruncated) return abortWithCode('LIMIT_FIELD_VALUE', fieldname)

      // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNameSize')) {
        if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
      }

      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNestingDepth')) {
        if (fieldname.split('[').length - 1 > limits.fieldNestingDepth) return abortWithCode('LIMIT_FIELD_NESTING', fieldname)
      }

      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldArrayIndexLimit')) {
        if (exceedsArrayIndexLimit(fieldname, limits.fieldArrayIndexLimit)) {
          return abortWithCode('LIMIT_FIELD_ARRAY_INDEX', fieldname)
        }
      }

      appendField(req.body, fieldname, value)
    })

    // handle files
    busboy.on('file', function (fieldname, fileStream, { filename, encoding, mimeType }) {
      var pendingWritesIncremented = false

      fileStream.on('error', function (err) {
        if (pendingWritesIncremented) {
          pendingWrites.decrement()
        }
        abortWithError(err)
      })

      if (fieldname == null) return abortWithCode('MISSING_FIELD_NAME')

      // don't attach to the files object, if there is no file
      if (!filename) return fileStream.resume()

      // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNameSize')) {
        if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
      }

      var file = {
        fieldname: fieldname,
        originalname: filename,
        encoding: encoding,
        mimetype: mimeType
      }

      var placeholder = appender.insertPlaceholder(file)

      fileFilter(req, file, function (err, includeFile) {
        if (errorOccured) {
          appender.removePlaceholder(placeholder)
          return fileStream.resume()
        }

        if (err) {
          appender.removePlaceholder(placeholder)
          return abortWithError(err)
        }

        if (!includeFile) {
          appender.removePlaceholder(placeholder)
          return fileStream.resume()
        }

        var aborting = false
        pendingWritesIncremented = true
        pendingWrites.increment()

        Object.defineProperty(file, 'stream', {
          configurable: true,
          enumerable: false,
          value: fileStream
        })

        fileStream.on('limit', function () {
          aborting = true
          abortWithCode('LIMIT_FILE_SIZE', fieldname)
        })

        storage._handleFile(req, file, function (err, info) {
          if (aborting) {
            appender.removePlaceholder(placeholder)
            uploadedFiles.push(extend(file, info))
            return pendingWrites.decrement()
          }

          if (err) {
            appender.removePlaceholder(placeholder)
            pendingWrites.decrement()
            return abortWithError(err)
          }

          var fileInfo = extend(file, info)

          appender.replacePlaceholder(placeholder, fileInfo)
          uploadedFiles.push(fileInfo)
          pendingWrites.decrement()
          indicateDone()
        })
      })
    })

    busboy.on('error', function (err) { abortWithError(err) })
    busboy.on('partsLimit', function () { abortWithCode('LIMIT_PART_COUNT') })
    busboy.on('filesLimit', function () { abortWithCode('LIMIT_FILE_COUNT') })
    busboy.on('fieldsLimit', function () { abortWithCode('LIMIT_FIELD_COUNT') })
    busboy.on('close', function () {
      readFinished = true
      indicateDone()
    })

    req.pipe(busboy)
  }
}

module.exports = makeMiddleware
