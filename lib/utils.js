/**
 * Module dependencies
 */

var path = require('path'),
    url = require('url'),
    fs = require('fs'),
    async = require('async'),
    logger = require('./logger'),
    prompt = require('prompt'),
    urlFormat = require('url').format,
    urlParse = require('url').parse,
    child_process = require('child_process'),
    evals = require('vm'),
    Script = evals.Script || evals.NodeScript;


/**
 * Converts a relative file path to properties on an object, and assigns a
 * value to that property. SIDE EFFECTS: modifies original 'obj' argument!
 *
 * Examples: some/test/file.js  =>  {some: {test: {file: ...} } }
 *
 * @param {Object} obj
 * @param {String} p
 * @param val
 * @return val
 * @see getPropertyPath
 * @api public
 */

exports.setPropertyPath = function (obj, p, val) {
    // normalize to remove unessecary . and .. from paths
    var parts = path.normalize(p).split('/');
    var curr = [];

    // loop through all parts of the path except the last, creating the
    // properties if they don't exist
    var prop = parts.slice(0, parts.length - 1).reduce(function (a, x) {
        curr.push(x);
        if (a[x] === undefined) {
            a[x] = {};
        }
        if (typeof a[x] === 'object' && !Array.isArray(a[x])) {
            a = a[x];
        }
        else {
            throw new Error(
                'Updating "' + p + '" would overwrite "' +
                    curr.join('/') + '"\n' +
                '\n' +
                'This can sometimes happen when a file has the same name as\n' +
                'a directory and both paths are added to the design doc.\n' +
                'There is no way to map this structure in the design doc.\n'
            );
        }
        return a;
    }, obj);

    // set the final property to the given value
    prop[path.basename(parts[parts.length - 1], '.js')] = val;

    return val;
};

/**
 * Returns an array of file-like paths from an object, prepending the 'root'
 * path provided to each
 *
 * eg, getPropertyPath('foo', {a: '', b: {c: ''}}) => ['foo/a', 'foo/b/c']
 */

exports.getPropertyPaths = function (root, obj) {
    if (typeof obj === 'object' && !Array.isArray(obj)) {
        var paths = [];
        for (var k in obj) {
            paths = paths.concat(
                exports.getPropertyPaths(root + '/' + k, obj[k])
            );
        }
        return paths;
    }
    return [root];
};

/**
 * Converts a relative file path to properties on an object, and returns
 * the value of that property. If invalid argument is set to true, invalid
 * paths return undefined instead of throwing an error.
 *
 * @param {Object} obj
 * @param {String} p
 * @param {Boolean} invalid
 * @see setPropertyPath
 * @api public
 */

exports.getPropertyPath = function (obj, p, invalid) {
    // normalize to remove unessecary . and .. from paths
    var parts = path.normalize(p).split('/');

    // if path is empty, return the root object
    if (!p) {
        return obj;
    }

    // loop through all parts of the path, throwing an exception
    // if a property doesn't exist
    for (var i = 0; i < parts.length; i++) {
        var x = parts[i];
        if (obj[x] === undefined) {
            if (invalid) {
                return undefined;
            }
            throw new Error('Invalid path: ' + p);
        }
        obj = obj[x];
    }
    return obj;
};

/**
 * List all files below a given path, recursing through subdirectories.
 *
 * @param {String} p
 * @param {Function} callback
 * @api public
 */

exports.descendants = function (p, callback) {
    fs.stat(p, function (err, stats) {
        if (err) {
            return callback(err);
        }
        if (stats.isDirectory()) {
            fs.readdir(p, function (err, files) {
                if (err) {
                    return callback(err);
                }
                var paths = files.map(function (f) {
                    return path.join(p, f);
                });
                async.concat(paths, exports.descendants, function (err, files) {
                    if (err) {
                        callback(err);
                    }
                    else {
                        callback(err, files);
                    }
                });
            });
        }
        else if (stats.isFile()) {
            callback(null, p);
        }
    });
};

/**
 * Gets all descendents of a path and tests against a regular expression,
 * returning all matching file paths.
 *
 * @param {String} p
 * @param {RegExp} pattern
 * @param {Function} callback
 * @api public
 */

exports.find = function (p, test, callback) {
    if (test instanceof RegExp) {
        var re = test;
        test = function (f) {
            return re.test(f);
        };
    }
    exports.descendants(p, function (err, files) {
        if (err) {
            return callback(err);
        }
        if (!Array.isArray(files)) {
            files = files ? [files]: [];
        }
        var matches = files.filter(function (f) {
            return test(f);
        });
        callback(null, matches);
    });
};

/**
 * Read a file from the filesystem and parse as JSON
 *
 * @param {String} path
 * @param {Function} callback
 * @api public
 */

exports.readJSON = function (path, callback) {
    fs.readFile(path, function (err, content) {
        var val;
        if (err) {
            return callback(err);
        }
        try {
            val = JSON.parse(content.toString());
        }
        catch (e) {
            var stack = e.stack.split('\n').slice(0, 1);
            stack = stack.concat(['\tin ' + path]);
            e.stack = stack.join('\n');
            return callback(e, null);
        }
        callback(null, val);
    });
};

/**
 * Returns the absolute path 'p1' relative to the absolute path 'p2'. If 'p1'
 * is already relative it is returned unchanged, unless both are relative.
 *
 * @param {String} p1
 * @param {String} p2
 * @return {String}
 * @api public
 */

exports.relpath = function (p1, p2) {
    // if both p1 and p2 are relative, change both to absolute
    if (p1[0] !== '/' && p2[0] !== '/') {
        p1 = exports.abspath(p1);
        p2 = exports.abspath(p2);
    }
    // if p1 is not absolute or p2 is not absolute, return p1 unchanged
    if (p1[0] !== '/' || p2[0] !== '/') {
        return p1;
    }

    // remove trailing slashes
    p1 = exports.rmTrailingSlash(p1);
    p2 = exports.rmTrailingSlash(p2);

    var p1n = path.normalize(p1).split('/'),
        p2n = path.normalize(p2).split('/');


    while (p1n.length && p2n.length && p1n[0] === p2n[0]) {
        p1n.shift();
        p2n.shift();
    }

    // if p1 is not a sub-path of p2, then we need to add some ..
    for (var i = 0; i < p2n.length; i++) {
        p1n.unshift('..');
    }

    return path.join.apply(null, p1n);
};


/**
 * Removes trailing slashes from paths.
 *
 * @param {String} p
 * @return {String}
 * @api public
 */

exports.rmTrailingSlash = function (p) {
    if (p.length > 1 && p[p.length - 1] === '/') {
        return p.substr(0, p.length - 1);
    }
    return p;
};


/**
 * Evals object literals used in properties files. The code is wrapped in
 * parenthesis for a more natural writing style and evaluated in a new
 * context to avoid interfering with the current scope.
 *
 * @param {String} code
 * @param {String} filename
 * @api public
 */

exports.evalSandboxed = function (code, filename) {
    try {
        var s = new Script('(' + code + ')', filename);
        return s.runInNewContext({});
    }
    catch (e) {
        var stack = e.stack.split('\n').slice(0, 1);
        stack = stack.concat(['\tin ' + filename]);
        e.stack = stack.join('\n');
        throw e;
    }
};

/**
 * Pads a string to minlength by appending spaces.
 *
 * @param {String} str
 * @param {Number} minlength
 * @return {String}
 * @api public
 */

exports.padRight = function (str, minlength) {
    while (str.length < minlength) {
        str += ' ';
    }
    return str;
};

/**
 * Ensures a directory exists using mkdir -p.
 *
 * @param {String} path
 * @param {Function} callback
 * @api public
 */

exports.ensureDir = function (path, callback) {
    var mkdir = child_process.spawn('mkdir', ['-p', path]);
    var err_data = '';
    mkdir.stderr.on('data', function (data) {
        err_data += data.toString();
    });
    mkdir.on('exit', function (code) {
        if (code !== 0) {
            return callback(new Error(err_data));
        }
        callback();
    });
};


exports.cp = function (/* optional */options, from, to, callback) {
    // options are optional
    if (!callback) {
        callback = to;
        to = from;
        from = options;
        options = [];
    }
    /* for options to an array */
    if (!Array.isArray(options)) {
        options = [options];
    }
    var cp = child_process.spawn('cp', options.concat([from, to]));
    var err_data = '';
    cp.stderr.on('data', function (data) {
        err_data += data.toString();
    });
    cp.on('exit', function (code) {
        if (code !== 0) {
            return callback(new Error(err_data));
        }
        callback();
    });
};

exports.mv = function (/* optional */options, from, to, callback) {
    // options are optional
    if (!callback) {
        callback = to;
        to = from;
        from = options;
        options = [];
    }
    /* for options to an array */
    if (!Array.isArray(options)) {
        options = [options];
    }
    var mv = child_process.spawn('mv', options.concat([from, to]));
    var err_data = '';
    mv.stderr.on('data', function (data) {
        err_data += data.toString();
    });
    mv.on('exit', function (code) {
        if (code !== 0) {
            return callback(new Error(err_data));
        }
        callback();
    });
};

exports.rm = function (/* optional */options, target, callback) {
    // options are optional
    if (!callback) {
        callback = target;
        target = options;
        options = [];
    }
    /* for options to an array */
    if (!Array.isArray(options)) {
        options = [options];
    }
    if (!Array.isArray(target)) {
        target = [target];
    }
    var rm = child_process.spawn('rm', options.concat(target));
    var err_data = '';
    rm.stderr.on('data', function (data) {
        err_data += data.toString();
    });
    rm.on('exit', function (code) {
        if (code !== 0) {
            return callback(new Error(err_data));
        }
        callback();
    });
};


/**
 * Returns absolute version of a path. Relative paths are interpreted
 * relative to process.cwd() or the cwd parameter. Paths that are already
 * absolute are returned unaltered.
 *
 * @param {String} p
 * @param {String} cwd
 * @return {String}
 * @api public
 */

exports.abspath = function (p, /*optional*/cwd) {
    if (p[0] === '/' || p[1] === ':' || p[0] === '\\') {
        return p;
    }
    cwd = cwd || process.cwd();
    return path.normalize(path.join(cwd, p));
};

/**
 * Recurses through the properties of an object, converting all functions to
 * strings representing their source code. Returns a JSON-compatible object
 * that will work with JSON.stringify.
 *
 * @param {Object} obj
 * @return {Object}
 * @api public
 */

exports.stringifyFunctions = function (obj) {
    if (typeof obj === 'function' || obj instanceof Function) {
        return obj.toString();
    }
    if (typeof obj === 'object') {
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                obj[k] = exports.stringifyFunctions(obj[k]);
            }
        }
    }
    return obj;
};

exports.getConfirmation = function (msg, callback) {
    function trim(str) {
        var trimmed = str.replace(/^\s*/, '');
        return trimmed.replace(/\s*$/, '');
    }

    if (!prompt.started) {
        prompt.start();
    }
    prompt.message = '';
    prompt.delimiter = '';

    var schema = {
        properties: {
            confirmation: {
                pattern: /^[yYnN]$/,
                description: msg + ' [Y/n]:'
            }
        }
    };
    prompt.get(schema, function(err, input) {
        var val = input.confirmation && trim(input.confirmation).toLowerCase();
        callback(err, val === '' || val === 'y');
    });
};

exports.getPassword = function (callback) {
    if (!prompt.started) {
        prompt.start();
    }
    prompt.message = '';
    prompt.delimiter = '';
    var schema = { properties: {
        password: {
            description: 'Password:',
            hidden: true
        }
    }};
    prompt.get(schema, function(err, input) {
        callback(err, input && input.password);
    });
};

exports.getUsername = function (callback) {
    if (!prompt.started) {
        prompt.start();
    }
    prompt.message = '';
    prompt.delimiter = '';
    var schema = { properties: {
        username: {
            description: 'Username:'
        }
    }};
    prompt.get(schema, function(err, input) {
        callback(err, input && input.username);
    });
};

exports.getAuth = function (url, callback) {
    var parsed = urlParse(url);
    // if a username has been specified, only ask for password
    if (parsed.auth && parsed.auth.split(':').length === 1) {
        console.log('Please provide credentials for: ' + url);
        exports.getPassword(function (err, password) {
            if (err) {
                return callback(err);
            }
            delete parsed.host;
            parsed.auth += ':' + password;
            console.log('');
            callback(null, urlFormat(parsed));
        });
    }
    else {
        delete parsed.auth;
        delete parsed.host;
        var noauth = exports.noAuthURL(url);
        console.log('Please provide credentials for: ' + noauth);
        exports.getUsername(function (err, username) {
            if (err) {
                return callback(err);
            }
            exports.getPassword(function (err, password) {
                if (err) {
                    return callback(err);
                }
                parsed.auth = username + ':' + password;
                callback(null, urlFormat(parsed));
            });
        });
    }
};

exports.padRight = function (str, len) {
    while (str.length < len) {
        str = str + ' ';
    }
    return str;
};

exports.longest = function (arr) {
    return arr.reduce(function (a, x) {
        if (x.length > a) {
            return x.length;
        }
        return a;
    }, 0);
};

exports.ISODateString = function (d) {
    function pad(n){
        return n < 10 ? '0' + n : n;
    }
    return d.getUTCFullYear() + '-' +
        pad(d.getUTCMonth() + 1) + '-' +
        pad(d.getUTCDate()) + 'T' +
        pad(d.getUTCHours()) + ':' +
        pad(d.getUTCMinutes()) + ':' +
        pad(d.getUTCSeconds()) + 'Z';
};

// tests if 'a' is a path below (or equal to) 'b'
exports.isSubPath = function (a, b) {
    var na = path.normalize(a);
    var nb = path.normalize(b);
    var pa = na.split('/');
    var pb = nb.split('/');
    if (pa.length < pb.length) {
        return false;
    }
    for (var i = 0; i < pb.length; i++) {
        if (pa[i] !== pb[i]) {
            return false;
        }
    }
    return true;
};

exports.formatSize = function (size) {
    var jump = 512;
    if (size < jump) return size + " bytes";
    var units = ["KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    var i = 0;
    while (size >= jump && i < units.length) {
        i += 1;
        size /= 1024
    }
    return size.toFixed(1) + ' ' + units[i - 1];
};

/**
 * Used by commands wanting to report a URL on the command-line without giving
 * away auth info.
 */

exports.noAuthURL = function (url) {
    var parts = urlParse(url);
    delete parts.auth;
    delete parts.host;
    return urlFormat(parts);
};


/**
 * Used by commands converting a URL argument to a real URL by attempting to
 * match against environments in .kansorc etc
 */

exports.argToEnv = function (settings, url) {
    if (!url) {
        if (settings && settings.env && settings.env.default) {
            env = settings.env.default;
            if (!env.db) {
                throw new Error('Environment missing db property');
            }
            return env;
        }
        else {
            throw new Error('No CouchDB URL specified');
        }
    }
    url = url.replace(/\/$/, '');

    if (!/^http/.test(url)) {
        var auth;
        if (url.indexOf('@') !== -1) {
            auth = url.split('@')[0];
            url = url.split('@').slice(1).join('@');
        }
        if (settings && settings.env && url in settings.env) {
            var env = settings.env[url];
            if (!env.db) {
                throw new Error('Environment missing db property');
            }
            if (auth) {
                var parsed = urlParse(env.db);
                parsed.auth = auth;
                env.db = urlFormat(parsed);
            }
            return env;
        }
        else {
            url = 'http://localhost:5984/' + url;
            if (auth) {
                var parsed = urlParse(url);
                parsed.auth = auth;
                url = urlFormat(parsed);
            }
            return {db: url};
        }
    }
    return url ? {db: url}: null;
};


/**
 * Used by commands wanting to add auth info to a URL. It will only prompt for
 * a password if the URL has a username, but no password associated with it.
 * Optionally you can force an auth prompt if the url has no auth data at all
 * by setting force to true.
 */

exports.completeAuth = function (url, force, callback) {
    var parsed = urlParse(url);
    if (parsed.auth) {
        // if only a username has been specified, ask for password
        if (parsed.auth.split(':').length === 1) {
            return exports.getAuth(url, callback);
        }
    }
    else if (force) {
        // no auth info, but auth required
        return exports.getAuth(url, callback);
    }
    callback(null, url);
};


exports.catchAuthError = function (fn, url, extra_args, callback) {
    fn.apply(null, [url].concat(extra_args).concat(function (err) {
        if (err && err.response && err.response.statusCode === 401) {
            logger.error(err.message || err.toString());
            exports.getAuth(url, function (err, url) {
                if (err) {
                    return callback(err);
                }
                console.log('');
                exports.catchAuthError(fn, url, extra_args, callback);
            });
        }
        else {
            callback.apply(this, arguments);
        }
    }));
};

/**
 * Reads the version property from Kanso's package.json
 */

exports.getKansoVersion = function (callback) {
    exports.readJSON(__dirname + '/../package.json', function (err, pkg) {
        if (err) {
            return callback(err);
        }
        return callback(null, pkg.version);
    });
};
