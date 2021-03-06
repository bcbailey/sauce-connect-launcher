var
  fs = require("fs"),
  path = require("path"),
  rimraf = require("rimraf"),
  os = require("os"),
  _ = require("lodash"),
  async = require("async"),
  http = require("http"),
  AdmZip = require("adm-zip"),
  spawn = require("child_process").spawn,
  exec = require("child_process").exec,
  archivefile,
  scDir = path.normalize(__dirname + "/../sc"),
  readyfile = path.normalize(os.tmpdir() + "/sc-launcher-readyfile"),
  exists = fs.existsSync || path.existsSync,
  currentTunnel,
  logger = console.log,
  cleanup_registered = false;

function killProcesses(callback) {
  callback = callback || function () {};

  if (!currentTunnel) {
    return callback();
  }

  currentTunnel.on("close", function () {
    currentTunnel = null;
    callback();
  });
  currentTunnel.kill("SIGTERM");
}

function clean(callback) {
  async.series([
    killProcesses,
    function (next) {
      rimraf(scDir, next);
    }
  ], callback);
}

function getArchiveName() {
  return {
    darwin: "sc-4.0-latest-osx.zip",
    win32: "sc-4.0-latest-win32.zip",
    win64: "sc-4.0-latest-win32.zip"
  }[process.platform] || "sc-4.0-latest-linux.tar.gz";
}

function getScFolderName() {
  return {
    darwin: "sc-4.0-osx",
    win32: "sc-4.0-win32",
    win64: "sc-4.0-win32"
  }[process.platform] || "sc-4.0-linux";
}

function getScBin() {
  return path.normalize(scDir + "/" + getScFolderName() + "/bin/sc");
}

// Make sure all processes have been closed
// when the script goes down
function closeOnProcessTermination() {
  if (cleanup_registered) {
    return;
  }
  cleanup_registered = true;
  process.on("exit", function () {
    logger("Shutting down");
    killProcesses();
  });
}

function unpackArchive(callback) {
  logger("Unzipping " + getArchiveName());
  setTimeout(function () {
    if (archivefile.match(/\.tar\.gz$/)) {
      exec("tar -xf " + archivefile, {cwd: scDir}, callback);
    } else {
      try {
        var zip = new AdmZip(archivefile);
        zip.extractAllTo(scDir, true);
      } catch (e) {
        return callback(new Error("ERROR Unzipping file: ", e.message));
      }
      callback(null);
    }
  }, 1000);
}

function download(options, callback) {
  var req = http.request({
      host: "saucelabs.com",
      port: 80,
      path: "/downloads/" + getArchiveName()
    });

  function removeArchive() {
    try {
      logger("Removing " + archivefile);
      fs.unlinkSync(archivefile);
    } catch (e) {}
    _.defer(process.exit.bind(null, 0));
  }

  logger("Missing Sauce Connect local proxy, downloading dependency");
  logger("This will only happen once.");

  req.on("response", function (res) {
    var len = parseInt(res.headers["content-length"], 10),
      prettyLen = (len / (1024 * 1024) + "").substr(0, 4);

    logger("Downloading " + prettyLen + "MB");

    res.pipe(fs.createWriteStream(archivefile));

    // cleanup if the process gets interrupted.
    process.on("exit", removeArchive);
    process.on("SIGHUP", removeArchive);
    process.on("SIGINT", removeArchive);
    process.on("SIGTERM", removeArchive);

    function done(err) {
      if (err) { return callback(new Error("Couldn't unpack archive: " + err.message)); }
      // write queued data before closing the stream
      logger("Removing " + getArchiveName());
      fs.unlinkSync(archivefile);
      logger("Sauce Connect installed correctly");
      callback(null);
    }

    res.on("end", function () {
      unpackArchive(done);
    });

  });

  req.end();
}



function run(options, callback) {
  callback = _.once(callback);

  function ready() {
    logger("Testing tunnel ready");
    closeOnProcessTermination();
    callback(null, child);
  }

  logger("Opening local tunnel using Sauce Connect");
  var child,
    watcher,
    args = [
      "-u", options.username || process.env.SAUCE_USERNAME,
      "-k", options.accessKey || process.env.SAUCE_ACCESS_KEY
    ],
    error,
    dataActions = {
      "Please wait for 'you may start your tests' to start your tests": function connecting() {
        logger("Creating tunnel with Sauce Labs");
      },
      //"you may start your tests": ready,
      "This version of Sauce Connect is outdated": function outdated() {

      },
      "Error: ": function handleError(data) {
        if (data.indexOf("failed to remove matching tunnels") !== -1) {
          logger("Invalid Sauce Connect Credentials");
          error = new Error("Invalid Sauce Connect Credentials. " + data);
        } else {
          error = new Error(data);
        }
      },
      "Goodbye.": function shutDown() {

      }
    };

  if (options.port) {
    args.push("-P", options.port);
  }

  if (options.proxy) {
    args.push("--proxy", options.proxy);
  }

  if (options.directDomains) {
    if (_.isArray(options.directDomains)) {
      options.directDomains = options.directDomains.join(",");
    }
    args.push("--direct-domains", options.directDomains);
  }

  if (options.fastFailRegexps) {
    if (_.isArray(options.fastFailRegexps)) {
      options.fastFailRegexps = options.fastFailRegexps.join(",");
    }
    args.push("--fast-fail-regexps", options.fastFailRegexps);
  }

  if (options.logfile) {
    args.push("-l", options.logfile);
  }

  if (options.tunnelIdentifier) {
    args.push("--tunnel-identifier", options.tunnelIdentifier);
  }

  args.push("--readyfile", readyfile);

  // Watching file as directory watching does not work on
  // all File Systems http://nodejs.org/api/fs.html#fs_caveats
  watcher = fs.watchFile(readyfile, {persistent: false}, function () {
    fs.exists(readyfile, function (exists) {
      if (exists) {
        logger("Detected sc ready");
        ready();
      }
    });
  });

  watcher.on("error", callback);

  logger("Starting sc with args: " + args.join(" "));

  child = spawn(getScBin(), args);

  currentTunnel = child;

  child.stdout.on("data", function (data) {
    data = data.toString().trim();
    if (options.verbose && data !== "") {
      console.log(data);
    }

    _.each(dataActions, function (action, key) {
      if (data.indexOf(key) !== -1) {
        action(data);
        return false;
      }
    });
  });

  child.on("exit", function (code, signal) {
    // Java exits with code 143 on SIGTERM; this is not an error, it comes from child.close
    /*if (code === 143) {
      return;
    }*/

    currentTunnel = null;

    if (error) { // from handleError() above
      return callback(error);
    }

    var message = "Closing Sauce Connect Tunnel";
    if (code > 0) {
      message = "Could not start Sauce Connect. Exit code " + code + " signal: " + signal;
      callback(new Error(message));
    }
    logger(message);
  });

  child.close = function (closeCallback) {
    if (closeCallback) {
      child.on("close", function () {
        closeCallback();
      });
    }
    child.kill("SIGTERM");
  };
}

function downloadAndStartProcess(options, callback) {
  if (arguments.length === 1) {
    callback = options;
    options = {};
  }
  logger = options.logger || function () {};

  if (!fs.existsSync(scDir)) {
    fs.mkdirSync(scDir);
  }

  function checkForArchive(next) {
    if (!exists(archivefile)) {
      download(options, next);
    } else {
      // the zip is being downloaded, poll for the binary to be ready
      async.doUntil(function wait(cb) {
        _.delay(cb, 1000);
      }, async.apply(exists, getScBin()), next);
    }
  }

  async.waterfall([
    function checkForBinary(next) {
      if (exists(getScBin())) {
        next(null);
      } else {
        checkForArchive(next);
      }
    },
    async.apply(run, options)
  ], callback);

}

archivefile = path.normalize(scDir + "/" + getArchiveName());

module.exports = downloadAndStartProcess;
module.exports.kill = killProcesses;
module.exports.getArchiveName = getArchiveName;
module.exports.clean = clean;


