/**
 * Module dependencies.
 */

var path = require('path');
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var o = require('outline');


/**
 * Module constants.
 */

var packagePathCache = {};


/**
 * `Metronome` constructor.
 */

function Metronome(settings) {
  EventEmitter.call(this);
  this.settings = settings || {};
  this._packages = {};
  this._queue = [];
  this._busy = false;
  this._services = {};
}

util.inherits(Metronome, EventEmitter);


/**
 * `Metronome` prototype.
 */

o.extend(Metronome.prototype, {

  /**
   * Register module with static config.
   */

  register: function register(config, base) {
    if (data.config.enabled === false) return this;
    this._enqueue(function (callback) {
      this._register(config, base, function (err) {
        if (err) return _this.emit('err', err);
        callback();
      });
    });
    return this;
  },


  /**
   * Register modules from config file.
   */

  config: function config(configFile) {
    var _this = this;
    _this._enqueue(function (callback) {
      require(configFile).forEach(function (config) {
        _this._register(config, path.dirname(configFile), function (err) {
          if (err) return _this.emit('err', err);
          callback();
        });
      });
    });
    return this;
  },


  /**
   * Register modules by scanning a directory containing config files.
   */

  scan: function scan(directory) {
    var _this = this;
    _this._enqueue(function (callback) {

      // Make directory absolute.
      if (directory[0] === '.') {
        directory = path.join(_this.get('root directory') || process.cwd(),
                             directory);
      }

      // List files.
      fs.readdir(directory, function (err, names) {
        if (err) return _this.emit('error', err);

        // Load each in order.
        function iterator(name, next) {
          if (name[0] === '.' && _this.get('ignore hidden files') !== false) {
            return next();
          }
          var absolutePath = path.join(directory, name);
          try {
            var required = require(absolutePath);
          }
          catch (err) {
            return _this.emit('error', err);
          }

          // Register it.
          _this._register(required, directory, function (err) {
            if (err) return _this.emit('error', err);
            next();
          });
        }

        function done(err) {
          if (err) return _this.emit('error', err);
          callback();
        }

        o.each(names, iterator, done);

      });
    });
    return _this;
  },


  /**
   * Start app.
   */

  bootstrap: function start() {
    var _this = this;
    _this._enqueue(function (callback) {

      // Prepare process.
      var remaining = [];
      var done = [];
      var reverse = {};
      o.each(_this._packages, function (data, name) {
        remaining.push(name);
        o.each(data.provides, function (service) {
          reverse[service] = name;
        });
      });

      // Check for missing dependencies, and check whether we can satisfy
      // weak dependencies.
      var consumes = {};
      try {
        o.each(_this._packages, function (data, name) {
          var missingDependencies = [];
          var packageConsumes = [];
          o.each(data.consumes, function (service) {
            if (!reverse[service]) return missingDependencies.push(service);
            packageConsumes.push(service);
          });
          if (missingDependencies.length) {
            throw Error([
              'Can\'t bootstrap package "', name,
              '" because of missing dependencies: "',
              missingDependencies.join('", "'), '".'
            ].join(''));
          }
          o.each(data.optionallyConsumes, function (service) {
            if (reverse[service]) packageConsumes.push(service);
          });
          consumes[name] = packageConsumes;
        });
      }
      catch (err) {
        return _this.emit('error', err);
      }

      // Helper checking whether we may process loading some package now.
      var canLoad = function canLoad(name) {
        var packageConsumes = consumes[name];
        var missing = o.filter(packageConsumes, function (service) {
          if (!_this._services[service]) return true;
        });
        return !missing.length;
      }

      // Helper bootstraping a specific package.
      var setup = function setup(name, done) {
        _this.emit('setup', name);
        var packageData = _this._packages[name];
        var config = packageData.config;
        packageData.setup(config, _this._services, function (err, services) {
          if (err) return done(err);
          services = services || {};
          o.each(packageData.provides, function (service) {
            _this._services[service] = services[service] || {};
          });
          done();
        });
      }

      // Start a big dirty infinite loop to start with the best order.
      var iterate = function iterate() {
        var newRemaining = [];
        o.each(remaining, function (remainingItem, next) {
          if (!canLoad(remainingItem)) {
            newRemaining.push(remainingItem);
            next();
          }
          else {
            setup(remainingItem, function (err) {
              next(err);
            });
          }
        }, function (err) {
          if (err) return _this.emit('error', err);

          // Maybe we're done
          if (!newRemaining.length) {
            _this.emit('bootstraped');
            return callback();
          }

          // Dit we reach a deadlock?
          if (newRemaining.length === remaining.length) {
            return _this.emit('error', Error([
              'Can\'t bootstrap because of circular dependency in packages: "',
              remaining.join('", "'), '".'
            ].join('')));
          }

          // Let's go for another round!
          remaining = newRemaining;
          process.nextTick(iterate);
        })
      };

      // Start the thing.
      iterate();

    });
    return _this;
  },


  /**
   * Get settings.
   */

  get: function get(key) {
    return this.settings[key];
  },


  /**
   * Set settings.
   */

  set: function set(key, value) {
    this.settings[key] = value;
    return this
  },


  /**
   * Get service.
   */

  service: function service(name) {
    return this._services[name];
  },


  /**
   * Enqueue arbitraity function.
   */

  then: function then(fn) {
    var _this = this;
    _this._enqueue(function (callback) {
      if (fn.length) {
        fn(function (err) {
          if (err) return _this.emit('error', err);
          callback();
        });
      }
      else {
        try {
          fn();
        }
        catch (err) {
          return _this.emit('error', err);
        }
        callback();
      }
    });
    return _this;
  },


  /**
   * Register method.
   */

  _register: function _register(config, root, callback) {
    var _this = this;
    config = typeof config === 'string' ? { packagePath: config } : config;
    resolvePackage(config.packagePath, root, function (packagePath) {
      if (!packagePath) {
        return callback(Error([
          'Can\'t locate package "', config.packagePath, '".'
        ].join('')));
      }
      var manifest = require(path.join(packagePath, 'package.json'));
      var name = manifest.name || path.basename(packagePath);
      var indexFile = manifest.main || 'index.js';
      var setup = require(path.join(packagePath, indexFile));
      _this._packages[name] = {
        path: packagePath,
        setup: setup,
        provides: manifest.provides || [],
        consumes: manifest.consumes || [],
        optionallyConsumes: manifest.optionallyConsumes || [],
        config: config
      }
      callback();
    });
  },


  /**
   * Processing queue.
   */

  _enqueue: function _enqueue(fn) {
    var _this = this;

    var callNext = function (err) {
      if (!_this._queue.length) {
        _this._busy = false;
      }
      else {
        process.nextTick(function () {
          (_this._queue.shift())(callNext);
        });
      }
    }

    if (!_this._busy) {
      _this._busy = true;
      fn(callNext);
    }
    else {
      _this._queue.push(fn);
    }

    return _this;
  }

});


/**
 * Factory.
 */

module.exports = function factory(options) {
  return new Metronome(options);
}


/**
 * Expose `Metronome`.
 */

module.exports.Metronome = Metronome;


/**
 * Expose version.
 */

module.exports.__defineGetter__('version', function () {
  return require(path.join(__dirname, 'package.json')).version;
});


/**
 * Node style, resolve package.
 */

function resolvePackage(packagePath, base, callback) {
  var tryPaths = [];
  if (packagePath[0] === '/') {
    tryPaths.push(packagePath);
  } else if (packagePath[0] === '.') {
    tryPaths.push(path.join(base, packagePath));
  } else {
    var tmpBase = base;
    while (true) {
      tryPaths.push(path.join(tmpBase, 'node_modules', packagePath));
      if (tmpBase === (tmpBase = path.dirname(tmpBase))) break;
    }
  }

  o.detect(tryPaths, isPackagePath, callback);
}

function isPackagePath(packagePath, callback) {
  fs.exists(path.join(packagePath, 'package.json'), callback);
}