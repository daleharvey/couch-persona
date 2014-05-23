#!/usr/bin/env node

"use strict";

var crypto = require('crypto');
var url = require('url');

var _ = require('underscore');
var async = require('async');
var request = require('request').defaults({json: true});
var uuid = require('node-uuid');

var express = require('express');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var logger = require('./log.js');
var Database = require('./db_utils.js');

// Prefix that will be added to every db created by couch-persona
var DB_PREFIX = process.env.DB_PREFIX || 'couch_persona_';

// URL to Persona verification server
var ASSERT_URL = process.env.ASSERT_URL ||
    'https://verifier.login.persona.org/verify';

function verifyAssert(assert, audience, callback) {
  logger.info('Verifying assertion');
  request({
    method: 'POST',
    uri: ASSERT_URL,
    form: {
      assertion: assert,
      audience: audience
    }
  }, function (err, res, body) {
    if (err || body.status === "failure") {
      callback({status: 400, json: {error: 'error_verifying_assertion'}});
    } else {
      callback(err, body);
    }
  });
}

function ensureUser(personaBody, callback) {
  logger.info('Ensuring', personaBody.email, 'user exists');
  var email = personaBody.email;
  var userDoc = createUserDoc(email);
  var userId = userDoc._id;
  db.getDocument('_users', userId, {}, function (err, doc) {
    if (!err) {
      if (doc !== null) {
        // Copy over any existing attributes (incl. _rev so we can update it)
        userDoc = _.extend(doc, userDoc);
      } else {
        userDoc.password = uuid.v1();
        userDoc.thepassword = userDoc.password;
        logger.info('User', personaBody.email, 'doesn\'t exist, creating ...');
      }
      db.putDocument('_users', userId, userDoc, {}, function (err) {
        if (!err) {
          callback(null, userDoc);
        } else {
          callback({status: 400, json: {error: 'error_creating_user'}});
        }
      });
    } else {
      callback({status: 400, json: {error: 'error_retrieving_user'}});
    }
  });
}

function verifyApp(appKey, userDoc, callback) {
  logger.info('Verifying application, key:' + appKey);
  db.getDocument(appKey, 'data', {}, function (err, doc) {
    if (!err && doc !== null) {
      // Email addresses arent valid database names, so just hash them
      var hash = crypto.createHash('md5').update(userDoc.name).digest("hex");
      userDoc.currentDb = DB_PREFIX + doc.dev + '_' + doc.name + '_' + hash;
      callback(null, userDoc);
    } else {
      callback({status: 400, json: {error: 'error_verifying_app'}});
    }
  });
}

function ensureDatabase(userDoc, callback) {
  logger.info('Ensuring', userDoc.currentDb, 'exists');
  db.createDatabase(userDoc.currentDb, {}, function (err) {
    if (!err || err === 412) {
      callback(null, userDoc);
    } else {
      callback({status: 400, json: {error: 'error_creating_database'}});
    }
  });
}

function ensureUserSecurity(userDoc, callback) {
  logger.info('Ensuring', userDoc.name, 'only can write to', userDoc.currentDb);
  db.secureDatabase(userDoc.currentDb, userDoc.name, {}, function (err) {
    if (!err) {
      callback(null, userDoc);
    } else {
      callback({status: 400, json: {error: 'error_securing_database'}});
    }
  });
}

function createSessionToken(userDoc, callback) {
  logger.info('Creating CouchDB session');
  var username = userDoc.name, password = userDoc.thepassword;
  db.createCouchSession(username, password, function (err, token) {
    if (!err) {
      userDoc.authToken = 'AuthSession=' + token + '; Path=/; HttpOnly';
      callback(null, userDoc, token);
    } else {
      callback({status: 400, json: {error: 'error_creating_session'}});
    }
  });
}

function createJanusSession(userDoc, couchToken, callback) {
  logger.info('Creating Janus session');
  var janusSession = {user: userDoc.name};
  db.putDocument('janus_session', couchToken, janusSession, {}, function (err) {
    if (!err) {
      callback(null, userDoc);
    } else {
      callback({status: 400, json: {error: 'error_creating_janus_session'}});
    }
  });
}

function getJanusSession(token, callback) {
  db.getDocument('janus_session', token, {}, function (err, doc) {
    if (!err && doc !== null) {
      db.checkCouchSession(token, function (err, authenticated) {
        if (!err) {
          if (authenticated) {
            callback(null, doc);
          } else {
            callback({status: 401, json: {error: 'session_expired'}});
          }
        } else {
          callback({status: 400, json: {error: 'error_checking_session'}});
        }
      });
    } else {
      callback({status: 401, json: {error: 'session_expired'}});
    }
  });
}

function sendJSON(client, status, content, hdrs) {
  var headers = _.extend({'Content-Type': 'application/json'}, hdrs);
  client.writeHead(status, headers);
  client.write(JSON.stringify(content));
  client.end();
}

function createUserDoc(email) {
  return {
    _id: 'org.couchdb.user:' + encodeURIComponent(email),
    type: 'user',
    name: email,
    roles: ['browserid'],
    browserid: true,
  };
}

function allowCrossDomain(req, res, next) {
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
}

exports.init = init;

var port = process.env.PORT || 5000;
var host = url.parse(process.env.HOST_URL || 'http://127.0.0.1:' + port);
var db = null;
var dbUrl;

function init(done) {

  if (!process.env.DB_URL) {
    console.log('DB_URL environment variable not set');
    process.exit(1);
  }

  dbUrl = url.parse(process.env.DB_URL);
  var dbConfig = {
    db: dbUrl
  };

  db = new Database(dbConfig, function () {
    startServer(done);
  });
}


function startServer(done) {

  var app = express();

  app.use(allowCrossDomain);
  app.use(cookieParser());
  app.use(express.static('www'));

  app.use('/db/', function (req, res) {
    var erl = url.format(dbUrl) + req.url.substring(1);
    req.pipe(request(erl)).pipe(res);
  });

  app.use(bodyParser.urlencoded());
  app.use(bodyParser.json());

  app.post('/login/', function (req, res) {

    if (req.body.key === 'developer') {
      // TODO: if we have a developer key, we need to create a dev account
      return;
    }

    async.waterfall([
      verifyAssert.bind(this, req.body.assert, req.headers.origin),
      ensureUser,
      verifyApp.bind(this, req.body.appkey),
      ensureDatabase,
      ensureUserSecurity,
      createSessionToken,
      createJanusSession
    ], function (err, userDoc) {
      if (err) {
        logger.error('Error during sign-in: ', err);
        sendJSON(res, err.status, err.json);
      } else {
        logger.info('Successful sign-in');
        sendJSON(res, 200, {
          ok: true,
          db: url.format(host) + 'db/' + userDoc.currentDb,
          name: userDoc.name
        }, {'Set-Cookie': userDoc.authToken});
      }
    });
  });

  app.post('/logout/', function (req, res) {
    var sessionKey = req.cookies.AuthSession;
    if (sessionKey === undefined) {
      sendJSON(res, 200, {ok: true});
    } else {
      async.waterfall([
        db.deleteDocument.bind(db, 'janus_session', sessionKey, {}),
        db.deleteCouchSession.bind(db, sessionKey)
      ], function (err) {
        sendJSON(res, 200, {ok: true});
      });
    }
  });

  app.put('/app/:key/', function (req, res) {
    var appKey = req.param('key');
    var sessionKey = req.cookies.AuthSession;
    if (sessionKey === undefined) {
      sendJSON(res, 401, {error: 'priviliges_required'});
      logger.info('Adding application ' + appKey + ' failed (privileges)');
    } else {
      async.waterfall([
        getJanusSession.bind(this, sessionKey),
        function (sessionDoc, callback) {
          db.createDatabase(appKey, {}, function (err) {
            callback(err, sessionDoc);
          });
        },
        function (sessionDoc, callback) {
          db.secureDatabase(appKey, sessionDoc.user, {}, function (err) {
            callback(err, sessionDoc);
          });
        },
        function (sessionDoc, callback) {
          var appData = {
            dev: sessionDoc.user,
            name: req.body.name || ""
          };
          db.putDocument(appKey, 'data', appData, {}, callback);
        }
      ], function (err) {
        if (!err) {
          sendJSON(res, 201, {ok: true});
          logger.info('Adding application ' + appKey + ' succeeded');
        } else {
          sendJSON(res, 400, {error: 'error_creating_app'});
          logger.info('Adding application ' + appKey + ' failed');
        }
      });
    }
  });

  app.delete('/app/:key/', function (req, res) {
    var appKey = req.param('key');
    var sessionKey = req.cookies.AuthSession;
    if (sessionKey === undefined) {
      sendJSON(res, 401, {error: 'privileges_required'});
      logger.info('Deleting application ' + appKey + ' failed (privileges)');
    } else {
      async.waterfall([
        getJanusSession.bind(this, sessionKey),
        function (sessionDoc, callback) {
          db.getDocument(appKey, 'data', {}, function (err, appDoc) {
            if (err || appDoc === null || appDoc.dev !== sessionDoc.user) {
              callback(true);
            } else {
              callback(null);
            }
          });
        },
        db.deleteDatabase.bind(db, appKey, {})
      ], function (err) {
        if (!err) {
          sendJSON(res, 200, {ok: true});
          logger.info('Deleting application ' + appKey + ' succeeded');
        } else {
          sendJSON(res, 400, {error: 'error_deleting_app'});
          logger.info('Deleting application ' + appKey + ' failed');
        }
      });
    }
  });

  app.listen(port);
  logger.info('Listening on ' + url.format(host));

  if (done) {
    done(app);
  }
}

if (require.main === module) {
  init();
}
