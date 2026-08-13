// Minimal tap-compatible adapter backed by node:test + node:assert.
//
// The module-deps test suite (test/*.js) was written for tap:
//
//   var test = require('tap').test
//   test('name', function (t) { t.plan(2); ...; t.equal(a, b) })
//
// Rather than rewrite every assertion, each top-level test file now requires
// this adapter instead of 'tap'. It registers a node:test test() per tap test
// and exposes a `t` object implementing the tap assertion surface actually used
// by this suite (see `git grep -hoE 't\.[a-zA-Z]+' test/*.js`):
//   plan, end, equal(s), notEqual, deepEqual, same, similar, ok, notOk/notok,
//   ifError, error, throws, doesNotThrow, fail, pass, comment, test (subtests),
//   teardown, timeoutAfter.
//
// Async handling (critical — module-deps tests are heavily async and stream
// output): tap signals completion via t.end() or by counting down t.plan(n).
// The node:test callback returns a promise that resolves only when the plan is
// satisfied or t.end() is called, so asynchronous assertions inside callbacks
// are awaited correctly. A test that calls t.plan(2) does not pass until both
// assertions have actually run. An assertion that fails — even deep inside an
// async callback — rejects that promise so node:test fails the correct test
// instead of surfacing an uncaught exception.
//
// Subtests: t.test(name, cb) registers a real node:test subtest via the parent
// test's context. node:test awaits subtests before finishing the parent, and
// each finished subtest counts as one assertion toward the parent's plan (tap
// semantics), so `t.plan(3)` + three subtests resolves correctly.

var nodeTest = require('node:test')
var assert = require('node:assert')

// A generous default per-test timeout so a genuinely hung async test fails
// loudly instead of hanging the whole run forever (tap defaulted to 30s; child
// processes here can be slow, so allow more headroom).
var DEFAULT_TIMEOUT = 120000

function makeT (resolve, reject, ctx) {
  var planned = null
  var count = 0
  var ended = false
  var teardowns = []
  var pendingSubtests = []

  function runTeardowns () {
    while (teardowns.length) {
      var fn = teardowns.shift()
      try { fn() } catch (e) { /* mirror tap: teardown errors are non-fatal here */ }
    }
  }

  // Resolve only once every subtest created by this test has settled, so that
  // node:test does not cancel still-running subtests when the parent's plan is
  // met or t.end() is called (tap waits for subtests before ending the parent).
  function finish () {
    if (ended) return
    ended = true
    Promise.all(pendingSubtests).then(settle, settle)
    function settle () { runTeardowns(); resolve() }
  }

  function bail (err) {
    if (ended) return
    ended = true
    runTeardowns()
    reject(err instanceof Error ? err : new Error(String(err && err.message || err)))
  }

  function bump () {
    if (ended) return
    count++
    if (planned !== null && count >= planned) finish()
  }

  // Wrap a synchronous assertion so a failure rejects the test promise (and
  // therefore fails this specific node:test test) even when it runs inside an
  // asynchronous callback, rather than escaping as an uncaught exception.
  function guard (fn) {
    return function () {
      if (ended) return
      try {
        fn.apply(null, arguments)
      } catch (e) {
        bail(e)
        return
      }
      bump()
    }
  }

  var t = {
    equal: guard(function (a, b, m) { assert.strictEqual(a, b, m) }),
    equals: guard(function (a, b, m) { assert.strictEqual(a, b, m) }),
    strictEqual: guard(function (a, b, m) { assert.strictEqual(a, b, m) }),
    notEqual: guard(function (a, b, m) { assert.notStrictEqual(a, b, m) }),
    notStrictEqual: guard(function (a, b, m) { assert.notStrictEqual(a, b, m) }),
    deepEqual: guard(function (a, b, m) { assert.deepEqual(a, b, m) }),
    same: guard(function (a, b, m) { assert.deepEqual(a, b, m) }),
    deepStrictEqual: guard(function (a, b, m) { assert.deepStrictEqual(a, b, m) }),
    notDeepEqual: guard(function (a, b, m) { assert.notDeepEqual(a, b, m) }),
    ok: guard(function (v, m) { assert.ok(v, m) }),
    true: guard(function (v, m) { assert.ok(v, m) }),
    notOk: guard(function (v, m) { assert.ok(!v, m) }),
    notok: guard(function (v, m) { assert.ok(!v, m) }),
    false: guard(function (v, m) { assert.ok(!v, m) }),
    ifError: guard(function (err, m) { assert.ifError(err) }),
    error: guard(function (err, m) { assert.ifError(err) }),
    ifErr: guard(function (err, m) { assert.ifError(err) }),
    // tap allows t.throws(fn, message): a string second argument is the
    // message, not an error matcher (node:assert would reject a string matcher).
    throws: guard(function (fn, expected, m) {
      if (typeof expected === 'string') { m = expected; expected = undefined }
      if (expected === undefined) assert.throws(fn, m)
      else assert.throws(fn, expected, m)
    }),
    doesNotThrow: guard(function (fn, expected, m) {
      if (typeof expected === 'string') { m = expected; expected = undefined }
      if (expected === undefined) assert.doesNotThrow(fn, m)
      else assert.doesNotThrow(fn, expected, m)
    }),
    // tap's t.similar / t.match: for a RegExp expectation, assert the pattern
    // matches String(actual); otherwise fall back to a deep comparison.
    similar: guard(function (actual, expected, m) {
      if (expected instanceof RegExp) {
        assert.ok(expected.test(String(actual)),
          m || (JSON.stringify(String(actual)) + ' does not match ' + expected))
      } else {
        assert.deepEqual(actual, expected, m)
      }
    }),
    match: guard(function (actual, expected, m) {
      if (expected instanceof RegExp) {
        assert.ok(expected.test(String(actual)),
          m || (JSON.stringify(String(actual)) + ' does not match ' + expected))
      } else {
        assert.deepEqual(actual, expected, m)
      }
    }),
    pass: guard(function (m) { assert.ok(true, m) }),
    // A failing assertion: reject immediately, do not count toward the plan.
    fail: function (m) {
      if (ended) return
      var err = (m instanceof Error) ? m : new Error(m ? ('fail: ' + m) : 'fail')
      bail(err)
    },
    comment: function (m) { console.log('# ' + m) },
    plan: function (n) {
      planned = n
      if (count >= planned) finish()
    },
    end: function (err) {
      if (err) { bail(err); return }
      finish()
    },
    teardown: function (fn) { if (typeof fn === 'function') teardowns.push(fn) },
    tearDown: function (fn) { if (typeof fn === 'function') teardowns.push(fn) },
    // Per-test deadline is handled by node:test's timeout option; honour the
    // call as a no-op so bodies that invoke it keep working.
    timeoutAfter: function () {},
    // Nested subtest: run it as a real node:test subtest under this test's
    // context so node:test awaits it, and count its completion as one
    // assertion toward this (parent) test's plan.
    test: function (name, subOpts, subCb) {
      if (typeof subOpts === 'function') { subCb = subOpts; subOpts = {} }
      var options = toNodeOptions(subOpts)
      var p = ctx.test(name, options, function (subCtx) {
        return runBody(subCb, subCtx)
      })
      var settled = Promise.resolve(p).then(bump, bump)
      pendingSubtests.push(settled)
      return p
    }
  }

  return t
}

function toNodeOptions (opts) {
  var options = { timeout: DEFAULT_TIMEOUT }
  if (opts) {
    if (opts.skip) options.skip = opts.skip
    if (opts.todo) options.todo = opts.todo
    if (typeof opts.timeout === 'number') options.timeout = opts.timeout
  }
  return options
}

function runBody (cb, ctx) {
  return new Promise(function (resolve, reject) {
    var t = makeT(resolve, reject, ctx)
    try {
      cb(t)
    } catch (err) {
      reject(err)
    }
  })
}

function test (name, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  var options = toNodeOptions(opts)
  return nodeTest(name, options, function (ctx) {
    return runBody(cb, ctx)
  })
}

// tap exposes both `require('tap')` (callable) and `require('tap').test`.
test.test = test
test.only = function (name, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  var options = toNodeOptions(opts)
  options.only = true
  return nodeTest(name, options, function (ctx) { return runBody(cb, ctx) })
}
test.skip = function (name, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  var options = toNodeOptions(opts)
  options.skip = true
  return nodeTest(name, options, function (ctx) { return runBody(cb, ctx) })
}

module.exports = test
module.exports.test = test
