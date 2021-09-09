var express = require('express');
var cors = require('cors');
var { MongoClient } = require('mongodb');
var bodyParser = require('body-parser');
var http = require('http');
var https = require('https');
var fs = require('fs');
const e = require('express');

var logFile = __dirname + "/connector.log";
function log(message, withDate = true, error = false, die = false) {
    date = new Date();
    var day = ("0" + date.getDate()).slice(-2);
    var month = ("0" + (date.getMonth() + 1)).slice(-2);
    var year = date.getFullYear();
    var hours = ("0" + date.getHours()).slice(-2);
    var minutes = ("0" + date.getMinutes()).slice(-2);
    var seconds = ("0" + date.getSeconds()).slice(-2);
    var dateStr = year + "-" + month + "-" + day + " " + hours + ":" + minutes + ":" + seconds;
    var dateMessage = "\n" + message;
    if (withDate) {
        dateMessage = "\n" + dateStr + ":: " + message;
    }
    fs.appendFileSync(logFile, dateMessage);
    if (error) {
        console.error(message);
    } else {
        console.log(message);
    }
    if (die) {
        console.log('Press any key to exit');
        const keypress = async () => {
            process.stdin.setRawMode(true)
            return new Promise(resolve => process.stdin.once('data', () => {
                process.stdin.setRawMode(false)
                resolve()
            }))
        }
        (async () => {
            await keypress()
        })().then(process.exit)
    }
}

log('==================================================', false)

fs.readFile(__dirname + '/config.json', 'utf8', function (err, data) {
    if (err) {
        log('config.json was not found or could not be opened: ')
        log(err, true, true, true);
    } else {
        var config = JSON.parse(data);

        var HTTPPort = config.HTTPPort || 8080;
        var HTTPSPort = config.HTTPSPort || 8443;
        var MongoDBConnectionURL = config.MongoDBConnectionURL || "";
        var MongoDBDatabase = config.MongoDBDatabase || "";
        var MongoDBCharacterCollection = config.MongoDBCharacterCollection || "characters";
        var MongoDBMessagesCollection = config.MongoDBMessagesCollection || "messages";
        var SSLCertificatePath = config.SSLCertificatePath || "";
        var SSLPrivateKeyPath = config.SSLPrivateKeyPath || "";

        var app = express()

        app.use(function (req, res, next) {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
            next();
        });

        if (MongoDBConnectionURL && MongoDBDatabase && MongoDBCharacterCollection && MongoDBMessagesCollection) {
            MongoClient.connect(MongoDBConnectionURL, function (err, client) {
                var db = client.db(MongoDBDatabase)
                var characters = db.collection(MongoDBCharacterCollection);
                var messages = db.collection(MongoDBMessagesCollection);

                //Returns all savegames.
                app.get('/listCharacters', cors(), function (req, res) {
                    characters.find().toArray(function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

                //Returns a savegame by ID.
                app.get('/loadCharacter/:query', cors(), function (req, res) {
                    var query = req.params.query;

                    characters.findOne({ 'id': query }, function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

                //Inserts or overwrites a savegame identified by its MongoDB _id, which is set to its own id.
                app.post('/saveCharacter', bodyParser.json(), function (req, res) {
                    var query = req.body;
                    query._id = query.id;

                    characters.findOneAndReplace({ _id: query._id }, query, { upsert: true, returnNewDocument: true }, function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

                //Deletes a savegame by ID.
                app.post('/deleteCharacter', bodyParser.json(), function (req, res) {
                    var query = req.body;

                    characters.findOneAndDelete({ 'id': query.id }, function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

                //Returns the current time in order to timestamp new messages on the frontend.
                app.get('/time', cors(), function (req, res) {
                    var time = new Date().getTime();
                    res.send({ time: time });
                })

                //Returns all messages addressed to this recipient.
                app.get('/loadMessages/:query', cors(), function (req, res) {
                    var query = req.params.query;

                    messages.find({ 'recipientId': query }).toArray(function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

                //Sends your messages to the database.
                app.post('/saveMessages', bodyParser.json(), function (req, res) {
                    var query = req.body;

                    messages.insertMany(query, function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

                //Deletes one message by id.
                app.post('/deleteMessage', bodyParser.json(), function (req, res) {
                    var query = req.body;

                    messages.findOneAndDelete({ 'id': query.id }, function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

                //Deletes all messages that are older than 10 minutes. The messages are timestamped with the above time to avoid issues arising from time differences.
                app.get('/cleanupMessages', cors(), function (req, res) {
                    var tenMinutesOld = new Date();
                    tenMinutesOld.setMinutes(tenMinutesOld.getMinutes() - 10);

                    messages.deleteMany({ 'timeStamp': { $lt: tenMinutesOld.getTime() } }, function (err, result) {
                        if (err) {
                            log(err, true, true);
                            res.status(500).send(err);
                        } else {
                            res.send(result)
                        }
                    })
                })

            })

            async function startHTTP() {
                var httpServer = http.createServer(app);
                try {
                    await new Promise((resolve, reject) => {
                        httpServer.listen(HTTPPort, () => {
                            log('HTTP connector is listening on port ' + HTTPPort);
                            resolve();
                        });
                        httpServer.once('error', (err) => {
                            reject(err);
                        });
                    });
                    return;
                } catch (err) {
                    log("HTTP connector could not be started: ");
                    log(err, true, true, true);
                }
            }
            startHTTP()

            if (SSLCertificatePath && SSLPrivateKeyPath) {
                try {
                    var certificate = fs.readFileSync(SSLCertificatePath, 'utf8');
                } catch (err) {
                    log('SSL certificate not found at ' + SSLCertificatePath)
                    certificate = "";
                }
                try {
                    var privateKey = fs.readFileSync(SSLPrivateKeyPath, 'utf8');
                } catch (err) {
                    log('SSL private key not found at ' + SSLPrivateKeyPath)
                    privateKey = "";
                }
                if (certificate && privateKey) {
                    var credentials = { key: privateKey, cert: certificate };

                    async function startHTTPS() {
                        var httpsServer = https.createServer(credentials, app);

                        try {
                            await new Promise((resolve, reject) => {
                                httpsServer.listen(HTTPSPort, () => {
                                    log('HTTPS connector is listening on port ' + HTTPSPort);
                                    resolve();
                                });
                                httpsServer.once('error', (err) => {
                                    reject(err);
                                });
                            });
                            return;
                        } catch (err) {
                            log("HTTPS connector could not be started: ");
                            log(err, true, true, true);
                        }
                    }
                    startHTTPS()
                } else {
                    log('HTTPS connector was not started.')
                }

            } else if (SSLCertificatePath || SSLPrivateKeyPath) {
                log('SSL information missing from config.json: ')
                if (!SSLCertificatePath) {
                    log(' SSLCertificatePath');
                }
                if (!SSLPrivateKeyPath) {
                    log(' SSLPrivateKeyPath');
                }
                log('HTTPS connector was not started.')
            }

        } else {
            log('Database information missing from config.json: ')
            if (!MongoDBConnectionURL) {
                log(' MongoDBConnectionURL');
            }
            if (!MongoDBDatabase) {
                log(' MongoDBDatabase');
            }
            if (!MongoDBCharacterCollection) {
                log(' MongoDBCharacterCollection');
            }
            if (!MongoDBMessagesCollection) {
                log(' MongoDBMessagesCollection');
            }
            log('Connector cannot be started.')
        }
    }

})