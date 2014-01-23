var constants = require("constants");

var fs = require("fs"),
    path = require("path");

var f4js = require("fuse4js"),
    MBTiles = require("mbtiles");

// TODO require these arguments
var args = process.argv.slice(2),
    filename = path.resolve(args.shift()),
    mountPoint = path.resolve(args.shift());

var tileStore;

/**
 * Convert a path into XYZ coords.
 */
var lookup = function(path) {
  var parts = path.split("/", 4);

  if (parts[1]) {
    var z = Number(parts[1]);
  }

  if (parts[2]) {
    var x = Number(parts[2]);
  }

  if (parts[3]) {
    var y = Number(parts[3].split(".")[0]);
  }

  return {
    z: z,
    x: x,
    y: y
  };
};

/**
 * getattr() system call handler.
 */
var getattr = function(path, callback) {
  var stat = {};
  var err = 0; // assume success
  var info = lookup(path);

  switch(true) {
  case info.y === undefined:
    if (Number.isNaN(info.z) || Number.isNaN(info.x)) {
      err = -constants.ENOENT;
    } else {
      stat.size = 4096; // standard size of a directory
      stat.mode = 040777; // directory with 777 permissions
    }
    break;

  case info.y > 0:
    stat.mode = 0100444; // file with 444 permissions

    // TODO get these from the mbtiles file (use that as the default, later
    // store metadata elsewhere
    stat.atime = new Date();
    stat.mtime = new Date();
    stat.ctime = new Date();

    tileStore.getTile(info.z, info.x, info.y, function(err, tile, options) {
      if (err) {
        console.warn(err, info);
        callback(-constants.ENOENT);
        return;
      }

      stat.size = tile.length;
      callback(0, stat);
    });
    return;
    break;

  default:
    err = -constants.ENOENT;
  };

  callback(err, stat);
};

var readdir = function(path, callback) {
  var info = lookup(path);

  if (info.y !== undefined) {
    callback(-constants.EINVAL); // this is a file
    return;
  }

  if (info.x !== undefined) {
    var query = tileStore._db.prepare("SELECT DISTINCT tile_row FROM tiles WHERE tile_column = ? AND zoom_level = ?", function(err) {
      if (err) {
        console.warn("readdir:", err, info);
        callback(-constants.EINVAL);
        return;
      }

      query.all(info.x, info.z, function(err, rows) {
        var names = rows.map(function(x) {
          var y = (1 << info.z) - 1 - x.tile_row;
          // TODO get format from info
          return String(y) + ".png";
        });

        callback(0, names);
      });
    });

    return;
  }

  if (info.z !== undefined) {
    var query = tileStore._db.prepare("SELECT DISTINCT tile_column FROM tiles WHERE zoom_level = ?", function(err) {
      if (err) {
        console.warn(err, info);
        callback(-constants.EINVAL);
        return;
      }

      query.all(info.z, function(err, rows) {
        var names = rows.map(function(x) {
          return String(x.tile_column);
        });

        callback(0, names);
      });
    });

    return;
  }

  // TODO use (cached) getInfo to determine this
  tileStore._db.all("SELECT DISTINCT zoom_level FROM tiles", function(err, rows) {
    var names = rows.map(function(x) {
      return String(x.zoom_level);
    });

    callback(0, names);
  });
};

/**
 * open() system call handler.
 */
var open = function(path, flags, callback) {
  var err = 0;
  var info = lookup(path);

  if (info.y === undefined) {
    err = -constants.ENOENT;
  }

  callback(err);
};

/**
 * read() system call handler.
 */
var read = function(path, offset, len, buf, fh, callback) {
  var err = 0;
  var info = lookup(path);
  var maxBytes;
  var data;

  if (info.y !== undefined) {
    tileStore.getTile(info.z, info.x, info.y, function(err, tile, options) {
      if (err) {
        console.warn(err, info);
        callback(-constants.ENOENT);
        return;
      }

      if (offset < tile.length) {
        maxBytes = tile.length - offset;
        if (len > maxBytes) {
          len = maxBytes;
        }

        tile.copy(buf, 0, offset, offset + len);
        err = len;
      }

      callback(err);
    });
  } else {
    callback(-constants.EPERM); // a directory
  }
};

/**
 * release() system call handler.
 */
var release = function(path, fh, callback) {
  callback(0);
};

var init = function(callback) {
  new MBTiles(filename, function(err, mbtiles) {
    if (err) throw err;

    tileStore = mbtiles;
    mbtiles.getInfo(function(err, info) {
      if (err) throw err;

      console.log("tileStore initialized.");
      console.log(info);
      callback();
    });
  });
};

var destroy = function(callback) {
  tileStore.close(callback);
};

var handlers = {
  getattr: getattr,
  readdir: readdir,
  open: open,
  read: read,
  // write: write,
  release: release,
  // create: create,
  // unlink: unlink,
  // rename: rename,
  // mkdir: mkdir,
  // rmdir: rmdir,
  init: init,
  destroy: destroy
};

fs.mkdir(mountPoint, function(err) {
  if (err && err.code !== "EEXIST") {
    throw err;
  }

  f4js.start(mountPoint, handlers, false);
});
