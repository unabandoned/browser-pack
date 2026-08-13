var JSONStream = require('JSONStream');
var umd = require('umd');
var Stream = require('node:stream');

var fs = require('fs');
var path = require('path');

var combineSourceMap = require('combine-source-map');

var Transform = Stream.Transform;
var PassThrough = Stream.PassThrough;
var Writable = Stream.Writable;

var defaultPreludePath = path.join(__dirname, '_prelude.js');
var defaultPrelude = fs.readFileSync(defaultPreludePath, 'utf8');

// defined(): the first argument that is not undefined. Previously the `defined`
// package; inlined here to drop a runtime dependency.
function defined () {
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined) return arguments[i];
  }
}

function newlinesIn(src) {
  if (!src) return 0;
  var newlines = src.match(/\n/g);

  return newlines ? newlines.length : 0;
}

module.exports = function (opts) {
    if (!opts) opts = {};

    // Node >= 22.12 ships everything the old shims provided, so this is plain
    // node:stream + the global Buffer:
    //   through2       -> object-mode Transform / PassThrough
    //   safe-buffer    -> global Buffer (Buffer.from is native)
    var parser = opts.raw ? new PassThrough({ objectMode: true }) : JSONStream.parse([ true ]);

    // `stream` is the object the caller writes rows (or JSON) into; the packer
    // below reads parsed rows and pushes the packed bundle back out through it.
    // The outer Transform's flush is deferred until the packer has emitted the
    // trailer (see end()), so the readable side ends only once packing is done.
    var finishOutput = null;
    var stream = new Transform({
        objectMode: true,
        transform: function (buf, enc, next) { parser.write(buf); next(); },
        flush: function (next) { finishOutput = next; parser.end(); }
    });
    parser.pipe(new Writable({
        objectMode: true,
        write: function (row, enc, next) { write(row, enc, next); },
        final: function (next) { end(); next(); }
    }));
    stream.standaloneModule = opts.standaloneModule;
    stream.hasExports = opts.hasExports;

    var first = true;
    var entries = [];
    var basedir = defined(opts.basedir, process.cwd());
    var prelude = opts.prelude || defaultPrelude;
    var preludePath = opts.preludePath ||
        path.relative(basedir, defaultPreludePath).replace(/\\/g, '/');

    var lineno = 1 + newlinesIn(prelude);
    var sourcemap;

    return stream;

    function write (row, enc, next) {
        if (first && opts.standalone) {
            var pre = umd.prelude(opts.standalone).trim();
            stream.push(Buffer.from(pre + 'return ', 'utf8'));
        }
        else if (first && stream.hasExports) {
            var pre = opts.externalRequireName || 'require';
            stream.push(Buffer.from(pre + '=', 'utf8'));
        }
        if (first) stream.push(Buffer.from(prelude + '({', 'utf8'));

        if (row.sourceFile && !row.nomap) {
            if (!sourcemap) {
                sourcemap = combineSourceMap.create(null, opts.sourceRoot);
                sourcemap.addFile(
                    { sourceFile: preludePath, source: prelude },
                    { line: 0 }
                );
            }
            sourcemap.addFile(
                { sourceFile: row.sourceFile, source: row.source },
                { line: lineno }
            );
        }

        var wrappedSource = [
            (first ? '' : ','),
            JSON.stringify(row.id),
            ':[',
            'function(require,module,exports){\n',
            combineSourceMap.removeComments(row.source),
            '\n},',
            '{' + Object.keys(row.deps || {}).sort().map(function (key) {
                return JSON.stringify(key) + ':'
                    + JSON.stringify(row.deps[key])
                ;
            }).join(',') + '}',
            ']'
        ].join('');

        stream.push(Buffer.from(wrappedSource, 'utf8'));
        lineno += newlinesIn(wrappedSource);

        first = false;
        if (row.entry && row.order !== undefined) {
            entries[row.order] = row.id;
        }
        else if (row.entry) entries.push(row.id);
        next();
    }

    function end () {
        if (first) stream.push(Buffer.from(prelude + '({', 'utf8'));
        entries = entries.filter(function (x) { return x !== undefined });

        stream.push(
            Buffer.from('},{},' + JSON.stringify(entries) + ')', 'utf8')
        );

        if (opts.standalone && !first) {
            stream.push(Buffer.from(
                '(' + JSON.stringify(stream.standaloneModule) + ')'
                    + umd.postlude(opts.standalone),
                'utf8'
            ));
        }

        if (sourcemap) {
            var comment = sourcemap.comment();
            if (opts.sourceMapPrefix) {
                comment = comment.replace(
                    /^\/\/#/, function () { return opts.sourceMapPrefix }
                )
            }
            stream.push(Buffer.from('\n' + comment + '\n', 'utf8'));
        }
        if (!sourcemap && !opts.standalone) {
            stream.push(Buffer.from(';\n', 'utf8'));
        }

        // End the readable side. If the caller ended us (flush pending), let the
        // Transform finish now that the trailer is pushed; otherwise end directly.
        if (finishOutput) finishOutput();
        else stream.push(null);
    }
};
