"use strict";

function SourceFile(lines, text) {
  lines = lines || [];
  this.lines = lines;
  this.text = text;
  this.offset2line = {};
  this.line2offset = {};
  for (var info of lines) {
    if (info.offset >= 0) {
      this.offset2line[info.offset] = info.line;
      this.line2offset[info.line] = info.offset;
    }
  }
  this.findLineForOffset = function(PC) {
    if (this.offset2line) {
      for (var i=0; i<16; i++) {
        var line = this.offset2line[PC];
        if (line >= 0) {
          return line;
        }
        PC--;
      }
    }
    return 0;
  }
  this.lineCount = function() { return lines.length; }
}

function CodeProject(worker, platform_id, platform, store) {
  var self = this;

  var filedata = {};  
  var listings;
  
  self.callbackResendFiles = function() { }; // TODO?
  self.callbackBuildResult = function(result) { };
  self.callbackBuildStatus = function(busy) { };
  
  var pendingWorkerMessages = 0;

  var tools_preloaded = {};
  function preloadWorker(path) {
    var tool = platform.getToolForFilename(path);
    if (tool && !tools_preloaded[tool]) {
      worker.postMessage({preload:tool, platform:platform_id});
      tools_preloaded[tool] = true;
    }
  }

  // TODO: get local file as well as presets?  
  self.loadFiles = function(paths, callback) {
    var result = [];
    function loadNext() {
      var path = paths.shift();
      if (!path) {
        callback(null, result); // TODO?
      } else {
        store.getItem(path, function(err, value) {
          if (err) {
            callback(err);
          } else if (value) {
            result.push({
              path:path,
              filename:getFilenameForPath(path),
              data:value
            });
            filedata[path] = value;
            loadNext();
          } else {
            var webpath = "presets/" + platform_id + "/" + path;
            if (platform_id == 'vcs' && path.indexOf('.') <= 0)
              webpath += ".a"; // legacy stuff
            // TODO: cache files
            $.get( webpath, function( text ) {
              console.log("GET",webpath,text.length,'bytes');
              result.push({
                path:path,
                filename:getFilenameForPath(path),
                data:text
              });
              filedata[path] = text;
              loadNext();
            }, 'text')
            .fail(function() {
              callback("Could not load preset " + path);
            });
          }
        });
      }
    }
    loadNext(); // load first file
  }
  
  function parseFileDependencies(text) {
    var files = [];
    if (platform_id == 'verilog') {
      var re = /^(`include|[.]include)\s+"(.+?)"/gm;
      var m;
      while (m = re.exec(text)) {
        files.push(m[2]);
      }
    } else {
      var re = /^([;#]|[/][/][#])link\s+"(.+?)"/gm;
      var m;
      while (m = re.exec(text)) {
        files.push(m[2]);
      }
    }
    return files;
  }

  function loadFileDependencies(text, callback) {
    var paths = parseFileDependencies(text);
    self.loadFiles(paths, callback);
  }
  
  function okToSend() {
    return pendingWorkerMessages++ == 0;
  }

  function updateFileInStore(path, text) {
    // protect against accidential whole-file deletion
    if (text.trim().length) {
      // TODO? (originalFileID != path || text != originalText)) {
      store.setItem(path, text);
    }
  }
  
  // TODO: test duplicate files, local paths mixed with presets
  function buildWorkerMessage(mainpath, maintext, depends) {
    var msg = {updates:[], buildsteps:[]};
    // TODO: add preproc directive for __MAINFILE__
    msg.updates.push({path:getFilenameForPath(mainpath), data:maintext});
    msg.buildsteps.push({path:getFilenameForPath(mainpath), platform:platform_id, tool:platform.getToolForFilename(mainpath), mainfile:true});
    for (var i=0; i<depends.length; i++) {
      var dep = depends[i];
      if (dep.data) {
        msg.updates.push({path:dep.filename, data:dep.data});
        msg.buildsteps.push({path:dep.filename, platform:platform_id, tool:platform.getToolForFilename(dep.path)});
      }
    }
    return msg;
  }
  
  self.getFile = function(path) {
    return filedata[path];
  }
  
  self.iterateFiles = function(callback) {
    for (var path in filedata) {
      callback(path, self.getFile(path));
    }
  }
  
  self.updateFile = function(path, text, isBinary) {
    updateFileInStore(path, text); // TODO: isBinary
    filedata[path] = text;
    if (okToSend()) {
      self.callbackBuildStatus(true);
      preloadWorker(path);
      loadFileDependencies(text, function(err, depends) {
        if (err) {
          console.log(err); // TODO?
        }
        if (platform_id != 'verilog') {
          var workermsg = buildWorkerMessage(path, text, depends);
          worker.postMessage(workermsg);
        } else {
          // TODO: should get rid of this msg format
          worker.postMessage({
            code:text,
            dependencies:depends,
            platform:platform_id,
            tool:platform.getToolForFilename(path)
          });
        }
      });
    }
  };
  
  self.processBuildResult = function(data) {
    // TODO: link listings with source files
    listings = data.listings;
    if (listings) {
      for (var lstname in listings) {
        var lst = listings[lstname];
        if (lst.lines)
          lst.sourcefile = new SourceFile(lst.lines);
        if (lst.asmlines)
          lst.assemblyfile = new SourceFile(lst.asmlines, lst.text);
      }
    }
  }
  
  self.getListings = function() {
    return listings;
  }

  worker.onmessage = function(e) {
    if (pendingWorkerMessages > 1) {
      self.callbackResendFiles(); // TODO: we should handle this internally
      pendingWorkerMessages = 0;
    } else {
      pendingWorkerMessages = 0;
    }
    self.callbackBuildStatus(false);
    if (e.data && !e.data.unchanged) {
      self.processBuildResult(e.data);
      self.callbackBuildResult(e.data); // call with data when changed
    }
  };
}

