var express = require('express');
var cors = require('cors');
var MongoClient = require('mongodb').MongoClient;
var bodyParser = require('body-parser');
var http = require('http');
var https = require('https');
var fs = require('fs');
var { JsonDB } = require('node-json-db');
var { Config } = require('node-json-db/dist/lib/JsonDBConfig');
var md5 = require('md5');
var uuidv4 = require('uuid').v4;

var logFile = __dirname + "/service.log";

//Rename old logfile if needed.
var oldlogFile = __dirname + "/connector.log";
if (fs.existsSync(oldlogFile)) {
    try {
        fs.renameSync(oldlogFile, logFile);
        log('==================================================', false)
        log("The logfile was renamed. The new logfile name is 'service.log'.");
    }
    catch (err)
    {
        log('==================================================', false)
        log("The logfile should be renamed, but could not:");
        log(err, true, true, false);
    }
}

function log(message, withDate = true, error = false, die = false) {
    date = new Date();
    const day = ("0" + date.getDate()).slice(-2);
    const month = ("0" + (date.getMonth() + 1)).slice(-2);
    const year = date.getFullYear();
    const hours = ("0" + date.getHours()).slice(-2);
    const minutes = ("0" + date.getMinutes()).slice(-2);
    const seconds = ("0" + date.getSeconds()).slice(-2);
    const dateStr = year + "-" + month + "-" + day + " " + hours + ":" + minutes + ":" + seconds;
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
        const config = JSON.parse(data);

        const HTTPPort = config.HTTPPort || 8080;
        const HTTPSPort = config.HTTPSPort || 8443;
        const MongoDBConnectionURL = config.MongoDBConnectionURL || "";
        const MongoDBDatabase = config.MongoDBDatabase || "";
        const MongoDBCharacterCollection = config.MongoDBCharacterCollection || "characters";
        const SSLCertificatePath = config.SSLCertificatePath || "";
        const SSLPrivateKeyPath = config.SSLPrivateKeyPath || "";
        const ConvertMongoDBToLocal = config.ConvertMongoDBToLocal || false;
        const GlobalPassword = config.Password ? md5(config.Password) : "";

        var messageStore = [];
        var tokenStore = [];

        const isWin = process.platform === "win32";        
        
        const app = express()

        app.use(function (req, res, next) {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-Access-Token");
            next();
        });

        //Attempt to login with a password.
        app.post('/login', bodyParser.json(), function (req, res) {
            const query = req.body;
            const token = Login(query.password);
            res.send({ token: token });
        })

        function Login(password) {
            if (GlobalPassword) {
                if (password == GlobalPassword) {
                    const time = new Date().getTime();
                    const id = uuidv4();
                    tokenStore.push({ id: id, timeStamp: time })
                    return id;
                } else {
                    return false;
                }
            } else {
                return "no-login-needed";
            }
        }

        function verify_Login(token) {
            if (GlobalPassword) {
                return tokenStore.some(storeToken => storeToken.id == token);
            } else {
                return true;
            }
        }

        async function cleanup_Logins() {
            while (true) {
                const timer = ms => new Promise(res => setTimeout(res, ms));
                await timer(36000000);
                const sevenDaysOld = new Date();
                sevenDaysOld.setHours(sevenDaysOld.getHours() - 168);
                tokenStore = tokenStore.filter(token => token.timeStamp >= sevenDaysOld.getTime());
            }
        }
        cleanup_Logins();

        if (MongoDBConnectionURL && MongoDBDatabase) {
            MongoClient.connect(MongoDBConnectionURL, function (err, client) {
                if (err) {
                    log("Failed to connect to the database! The connector will not run: ");
                    log(err, true, true, true);
                } else {
                    var db = client.db(MongoDBDatabase)
                    const characters = db.collection(MongoDBCharacterCollection);

                    db.listCollections({ name: MongoDBCharacterCollection }).next(function (err, collinfo) {
                        if (!collinfo) {
                            db.createCollection(MongoDBCharacterCollection, function (err, result) {
                                if (err) {
                                    if (err.codeName != "NamespaceExists") {
                                        log("The characters collection '" + MongoDBCharacterCollection + "' does not exist and could not be created. The connector will not run: ");
                                        log(err, true, true, true);
                                    }
                                } else {
                                    log("The characters collection '" + MongoDBCharacterCollection + "' was created on the database.");
                                }
                            });
                        }
                    })

                    if (ConvertMongoDBToLocal) {
                        log("Converting characters from MongoDB to local database.")
                        if (isWin) {
                            var localDB = new JsonDB(new Config(process.env.APPDATA + "/kironet/pecs/characters", true, true, '/'));
                        } else {
                            var localDB = new JsonDB(new Config(process.env.HOME + "/.kironet_pecs/characters", true, true, '/'));
                        }
                        characters.find().toArray(function (err, result) {
                            if (err) {
                                log("Unable to load characters from MongoDB: ")
                                log(err, true, true);
                            } else {
                                result.forEach(char => {
                                    localDB.push("/" + char.id, char);
                                })
                                log("All characters have been converted. MongoDB is still the connected database. Please remove the database parameters from the config file now and restart the application.", true, false, true);
                            }
                        })
                    }

                    //Returns all savegames.
                    app.get('/listCharacters', cors(), function (req, res) {
                        if (verify_Login(req.headers['x-access-token'])) {
                            characters.find().toArray(function (err, result) {
                                if (err) {
                                    log(err, true, true);
                                    res.status(500).send(err);
                                } else {
                                    res.send(result)
                                }
                            })
                        } else {
                            res.status(401).json({ message: 'Unauthorized Access' })
                        }
                    })

                    //Returns a savegame by ID.
                    app.get('/loadCharacter/:query', cors(), function (req, res) {
                        if (verify_Login(req.headers['x-access-token'])) {
                            const query = req.params.query;

                            characters.findOne({ 'id': query }, function (err, result) {
                                if (err) {
                                    log(err, true, true);
                                    res.status(500).send(err);
                                } else {
                                    res.send(result)
                                }
                            })
                        } else {
                            res.status(401).json({ message: 'Unauthorized Access' })
                        }
                    })

                    //Inserts or overwrites a savegame identified by its MongoDB _id, which is set to its own id.
                    app.post('/saveCharacter', bodyParser.json(), function (req, res) {
                        if (verify_Login(req.headers['x-access-token'])) {
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
                        } else {
                            res.status(401).json({ message: 'Unauthorized Access' })
                        }
                    })

                    //Deletes a savegame by ID.
                    app.post('/deleteCharacter', bodyParser.json(), function (req, res) {
                        if (verify_Login(req.headers['x-access-token'])) {
                            const query = req.body;
                            characters.findOneAndDelete({ 'id': query.id }, function (err, result) {
                                if (err) {
                                    log(err, true, true);
                                    res.status(500).send(err);
                                } else {
                                    res.send(result)
                                }
                            })
                        } else {
                            res.status(401).json({ message: 'Unauthorized Access' })
                        }
                    })

                }
            })
        } else if (MongoDBConnectionURL || MongoDBDatabase) {
            log('Database information is configured but incomplete. The following information is missing from config.json: ')
            if (!MongoDBConnectionURL) {
                log(' MongoDBConnectionURL');
            }
            if (!MongoDBDatabase) {
                log(' MongoDBDatabase');
            }
            log('Connector cannot be started.', true, true, true)
        } else {
            //Load Database from characters.json under APPDATA\bukiro\pecs or HOME/.bukiro/pecs.
            //They were stored in APPDATA\kironet\pecs or HOME/.kironet_pecs before, so have to be moved with some unfortunate file movements.
            if (isWin) {
                try {
                    const oldDir = process.env.APPDATA + "/kironet/pecs";
                    const newDir = process.env.APPDATA + "/bukiro/pecs";
                    const file = "/characters.json";
                    if (fs.existsSync(oldDir + file) && !fs.existsSync(newDir + file)) {
                        log("Characters were found under %appdata%\\kironet and will be moved to %appdata%\\bukiro.");
                        //Create bukiro and bukiro/pecs if they don't exist, then move kironet/pecs/characters.json to bukiro/pecs/.
                        if (!fs.existsSync(process.env.APPDATA + "/bukiro")) {
                            fs.mkdirSync(process.env.APPDATA + "/bukiro");
                        }
                        if (!fs.existsSync(newDir)) {
                            fs.mkdirSync(newDir);
                        }
                        fs.renameSync(oldDir + file, newDir + file);
                        //Remove kironet/pecs if empty.
                        fs.readdir(oldDir, function (err, data) {
                            if (data.length == 0) {
                                fs.rmdir(oldDir, () => {
                                    //Remove kironet if empty.
                                    fs.readdir(process.env.APPDATA + "/kironet", function (err, data) {
                                        if (data.length == 0) {
                                            fs.rmdir(process.env.APPDATA + "/kironet", () => {
                                            });
                                        }
                                    })
                                });
                            }
                        })
                        //Remove kironet if empty.
                        fs.readdir(process.env.APPDATA + "/kironet", function (err, data) {
                            if (data.length == 0) {
                                fs.rmdir(process.env.APPDATA + "/kironet", () => {
                                });
                            }
                        })
                    }
                    var db = new JsonDB(new Config(process.env.APPDATA + "/bukiro/pecs/characters", true, true, '/'));
                } catch (error) {
                    log("Characters could not be moved and remain in %appdata%\\kironet:");
                    log(error.message, true, true);
                    var db = new JsonDB(new Config(process.env.APPDATA + "/kironet/pecs/characters", true, true, '/'));
                }
            } else {
                try {
                    const oldDir = process.env.HOME + "/.kironet_pecs";
                    const newDir = process.env.HOME + "/.bukiro/pecs";
                    const file = "/characters.json";
                    if (fs.existsSync(oldDir + file) && !fs.existsSync(newDir + file)) {
                        log("Characters were found under ~/.kironet_pecs and will be moved to ~/.bukiro/pecs.");
                        //Create .bukiro and .bukiro/pecs if they don't exist, then move .kironet_pecs/characters.json to .bukiro/pecs/.
                        if (!fs.existsSync(process.env.HOME + "/.bukiro")) {
                            fs.mkdirSync(process.env.HOME + "/.bukiro");
                        }
                        if (!fs.existsSync(newDir)) {
                            fs.mkdirSync(newDir);
                        }
                        fs.renameSync(oldDir + file, newDir + file);
                        //Remove .kironet_pecs if empty.
                        fs.readdir(oldDir, function (err, data) {
                            if (data.length == 0) {
                                fs.rmdir(oldDir, () => {
                                });
                            }
                        })
                    }
                    var db = new JsonDB(new Config(process.env.HOME + "/.bukiro/pecs/characters", true, true, '/'));
                } catch (error) {
                    log("Characters could not be moved and remain in ~/.kironet_pecs:");
                    log(error.message, true, true);
                    var db = new JsonDB(new Config(process.env.HOME + "/.kironet_pecs/characters", true, true, '/'));
                }
            }

            //Returns all savegames.
            app.get('/listCharacters', cors(), function (req, res) {
                if (verify_Login(req.headers['x-access-token'])) {
                    const characterResults = db.getData("/");
                    if (characterResults) {
                        result = Object.values(characterResults);
                        res.send(result);
                    } else {
                        res.send([]);
                    }
                } else {
                    res.status(401).json({ message: 'Unauthorized Access' })
                }
            })

            //Returns a savegame by ID.
            app.get('/loadCharacter/:query', cors(), function (req, res) {
                if (verify_Login(req.headers['x-access-token'])) {
                    const query = req.params.query;
                    const result = db.getData("/" + query);
                    res.send(result);
                } else {
                    res.status(401).json({ message: 'Unauthorized Access' })
                }
            })

            //Inserts or overwrites a savegame identified by its MongoDB _id, which is set to its own id.
            app.post('/saveCharacter', bodyParser.json(), function (req, res) {
                if (verify_Login(req.headers['x-access-token'])) {
                    var query = req.body;
                    query._id = query.id;
                    try {
                        var exists = db.getData("/" + query.id) ? true : false;
                    } catch (error) {
                        var exists = false;
                    };

                    db.push("/" + query.id, query);

                    if (exists) {
                        result = { result: { n: 1, ok: 1 }, lastErrorObject: { updatedExisting: 1 } };
                    } else {
                        result = { result: { n: 1, ok: 1 } };
                    }
                    res.send(result);
                } else {
                    res.status(401).json({ message: 'Unauthorized Access' })
                }
            })

            //Deletes a savegame by ID.
            app.post('/deleteCharacter', bodyParser.json(), function (req, res) {
                if (verify_Login(req.headers['x-access-token'])) {
                    const query = req.body;

                    db.delete("/" + query.id);
                    result = { result: { n: 1, ok: 1 } };
                    res.send(result);
                } else {
                    res.status(401).json({ message: 'Unauthorized Access' })
                }
            })

        }

        //Returns the current time in order to timestamp new messages on the frontend.
        app.get('/time', cors(), function (req, res) {
            if (verify_Login(req.headers['x-access-token'])) {
                const time = new Date().getTime();
                res.send({ time: time });
            } else {
                res.status(401).json({ message: 'Unauthorized Access' })
            }
        })

        //Returns all messages addressed to this recipient.
        app.get('/loadMessages/:query', cors(), function (req, res) {
            if (verify_Login(req.headers['x-access-token'])) {
                const query = req.params.query;
                const result = messageStore.filter(message => message.recipientId == query);
                res.send(result)
            } else {
                res.status(401).json({ message: 'Unauthorized Access' })
            }
        })

        //Sends your messages to the database.
        app.post('/saveMessages', bodyParser.json(), function (req, res) {
            if (verify_Login(req.headers['x-access-token'])) {
                const query = req.body;
                messageStore.push(...query);
                const result = { result: { ok: 1, n: query.length }, ops: query, insertedCount: query.length }
                res.send(result);
            } else {
                res.status(401).json({ message: 'Unauthorized Access' })
            }
        })

        //Deletes one message by id.
        app.post('/deleteMessage', bodyParser.json(), function (req, res) {
            if (verify_Login(req.headers['x-access-token'])) {
                const query = req.body;
                const messageToDelete = messageStore.find(message => message.id == query.id);
                if (messageToDelete) {
                    var result = { lastErrorObject: { n: 1 }, value: messageToDelete, ok: 1 }
                } else {
                    var result = { lastErrorObject: { n: 0 }, value: null, ok: 1 }
                }
                messageStore = messageStore.filter(message => message.id != query.id);
                res.send(result);
            } else {
                res.status(401).json({ message: 'Unauthorized Access' })
            }
        })

        //Deletes all messages that are older than 10 minutes. The messages are timestamped with the above time to avoid issues arising from time differences.
        app.get('/cleanupMessages', cors(), function (req, res) {
            if (verify_Login(req.headers['x-access-token'])) {
                var tenMinutesOld = new Date();
                tenMinutesOld.setMinutes(tenMinutesOld.getMinutes() - 10);
                const messagesToDelete = messageStore.filter(message => message.timeStamp < tenMinutesOld.getTime());
                const result = { result: { n: messagesToDelete.length, ok: 1 }, deletedCount: messagesToDelete.length };
                messageStore = messageStore.filter(message => message.timeStamp >= tenMinutesOld.getTime());
                res.send(result);
            } else {
                res.status(401).json({ message: 'Unauthorized Access' })
            }
        })

        if (!(MongoDBConnectionURL && MongoDBDatabase && ConvertMongoDBToLocal)) {
            async function startHTTP() {
                const httpServer = http.createServer(app);
                try {
                    await new Promise((resolve, reject) => {
                        httpServer.listen(HTTPPort, () => {
                            log('HTTP service is listening on port ' + HTTPPort);
                            resolve();
                        });
                        httpServer.once('error', (err) => {
                            reject(err);
                        });
                    });
                    return;
                } catch (err) {
                    log("HTTP service could not be started: ");
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
                    const credentials = { key: privateKey, cert: certificate };

                    async function startHTTPS() {
                        const httpsServer = https.createServer(credentials, app);

                        try {
                            await new Promise((resolve, reject) => {
                                httpsServer.listen(HTTPSPort, () => {
                                    log('HTTPS service is listening on port ' + HTTPSPort);
                                    resolve();
                                });
                                httpsServer.once('error', (err) => {
                                    reject(err);
                                });
                            });
                            return;
                        } catch (err) {
                            log("HTTPS service could not be started: ");
                            log(err, true, true, true);
                        }
                    }
                    startHTTPS()
                } else {
                    log('HTTPS service was not started.')
                }
            } else if (SSLCertificatePath || SSLPrivateKeyPath) {
                log('SSL information missing from config.json: ')
                if (!SSLCertificatePath) {
                    log(' SSLCertificatePath');
                }
                if (!SSLPrivateKeyPath) {
                    log(' SSLPrivateKeyPath');
                }
                log('HTTPS service was not started.')
            }
        }
    }

})