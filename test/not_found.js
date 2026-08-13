var test = require('./tap-adapter').test;
var pack = require('../');
var Stream = require('node:stream');

// concat(cb): buffer every chunk, then hand back one Buffer. Node >= 22.12
// makes this a few lines over node:stream, so the abandoned concat-stream
// dependency (and the readable-stream v3 tree it pulled in) is dropped.
function concat (cb) {
    var chunks = [];
    return new Stream.Writable({
        write: function (chunk, enc, next) {
            chunks.push(Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk, enc && enc !== 'buffer' ? enc : 'utf8'));
            next();
        },
        final: function (next) { cb(Buffer.concat(chunks)); next(); }
    });
}

test('not found', function (t) {
    t.plan(6);
    
    var p = pack({ raw: true, hasExports: true });
    var src = '';
    p.pipe(concat(function (src) {
        var r = Function(['T'], 'return ' + src)(t);
        t.equal(r('xyz')(5), 555);
        t.equal(r('xyz')(5), 555);
        t.throws(function() {
            r('zzz');
        }, /Cannot find module 'zzz'/);
        try { r('zzz') }
        catch (err) { t.equal(err.code, 'MODULE_NOT_FOUND') }
    }));
    
    p.write({
        id: 'abc',
        source: 'T.equal(require("./xyz")(3), 333)',
        entry: true,
        deps: { './xyz': 'xyz' }
    });
    
    p.write({
        id: 'xyz',
        source: 'T.ok(true); module.exports=function(n){return n*111}'
    });
    
    p.end();
});
