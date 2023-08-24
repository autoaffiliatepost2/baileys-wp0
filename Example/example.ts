import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import request from 'request'
import http from 'http'
import express from 'express'
import { body, validationResult } from 'express-validator'
import fileUpload  from  'express-fileupload'
import bodyParser from  'body-parser'

const logger = MAIN_LOGGER.child({})
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined

const port = process.env.PORT || 9500;
const app = express();
const server = http.createServer(app);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));
app.use(fileUpload({
  debug: true
}));

setInterval( function setup() {
	testServer();
}, 19000)

function testServer(){   
	request({
	  uri: "https://dummydemo-88kg.onrender.com/",
	  method: "GET",
	}, (err, response, body) => {
	  console.log('body: ', body);
	})
  }

app.get('/', function(req, res, next) {
	res.render('respond with a resource');
  }); 

store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		mobile: useMobile,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage,
	})

	store?.bind(sock.ev)

	// Pairing code for Web clients
	if(usePairingCode && !sock.authState.creds.registered) {
		if(useMobile) {
			throw new Error('Cannot use pairing code with mobile api')
		}

		const phoneNumber = await question('Please enter your mobile phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	// If mobile was chosen, ask for the code
	if(useMobile && !sock.authState.creds.registered) {
		const { registration } = sock.authState.creds || { registration: {} }

		if(!registration.phoneNumber) {
			registration.phoneNumber = await question('Please enter your mobile phone number:\n')
		}

		const libPhonenumber = await import("libphonenumber-js")
		const phoneNumber = libPhonenumber.parsePhoneNumber(registration!.phoneNumber)
		if(!phoneNumber?.isValid()) {
			throw new Error('Invalid phone number: ' + registration!.phoneNumber)
		}

		registration.phoneNumber = phoneNumber.format('E.164')
		registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
		registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
		const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
		if(!mcc) {
			throw new Error('Could not find MCC for phone number: ' + registration!.phoneNumber + '\nPlease specify the MCC manually.')
		}

		registration.phoneNumberMobileCountryCode = mcc

		async function enterCode() {
			try {
				const code = await question('Please enter the one time code:\n')
				const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
				console.log('Successfully registered your phone number.')
				rl.close()
			} catch(error) {
				console.error('Failed to register your phone number. Please try again.\n', error)
				await askForOTP()
			}
		}

		async function enterCaptcha() {
			const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
			const path = __dirname + '/captcha.png'
			fs.writeFileSync(path, Buffer.from(response.image_blob!, 'base64'))

			open(path)
			const code = await question('Please enter the captcha code:\n')
			fs.unlinkSync(path)
			registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
		}

		async function askForOTP() {
			if (!registration.method) {
				let code = await question('How would you like to receive the one time code for registration? "sms" or "voice"\n')
				code = code.replace(/["']/g, '').trim().toLowerCase()
				if(code !== 'sms' && code !== 'voice') {
					return await askForOTP()
				}

				registration.method = code
			}

			try {
				await sock.requestRegistrationCode(registration)
				await enterCode()
			} catch(error) {
				console.error('Failed to request registration code. Please try again.\n', error)

				if(error?.reason === 'code_checkpoint') {
					await enterCaptcha()
				}

				await askForOTP()
			}
		}

		askForOTP()
	}

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			// if(events['labels.association']) {
			// 	console.log(events['labels.association'])
			// }


			// if(events['labels.edit']) {
			// 	console.log(events['labels.edit'])
			// }

			// if(events.call) {
			// 	console.log('recv call event', events.call)
			// }

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest } = events['messaging-history.set']
				// console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']

				if(upsert.type === 'notify') {
					for(const msg of upsert.messages) {
						if(!msg.key.fromMe && doReplies) {
							await sock!.readMessages([msg.key])
							await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation = await getMessage(key)
						if(pollCreation) {
						}
					}
				}
			}

			// if(events['message-receipt.update']) {
			// 	console.log(events['message-receipt.update'])
			// }

			// if(events['messages.reaction']) {
			// 	console.log(events['messages.reaction'])
			// }

			// if(events['presence.update']) {
			// 	console.log(events['presence.update'])
			// }

			// if(events['chats.update']) {
			// 	console.log(events['chats.update'])
			// }

			// if(events['contacts.update']) {
			// 	for(const contact of events['contacts.update']) {
			// 		if(typeof contact.imgUrl !== 'undefined') {
			// 			const newUrl = contact.imgUrl === null
			// 				? null
			// 				: await sock!.profilePictureUrl(contact.id!).catch(() => null)
			// 			console.log(
			// 				`contact ${contact.id} has a new profile pic: ${newUrl}`,
			// 			)
			// 		}
			// 	}
			// }

			// if(events['chats.delete']) {
			// 	console.log('chats deleted ', events['chats.delete'])
			// }
		}
	)

		// Send message
		app.post('/send-message', [
			body('number').notEmpty(),
			body('message').notEmpty(),
		  ], async (req, res) => {
		const errors = validationResult(req).formatWith(({
		  msg
		}) => {
		  return msg;
		});
	  
		if (!errors.isEmpty()) {
		  return res.status(422).json({
			status: false,
			message: errors.mapped()
		  });
		}
	  
		const number = req.body.number;
		const message = req.body.message;
		// const number = '918733966597@s.whatsapp.net';
		// const message = 'req.body.message';
	  
		
		await sock.sendMessage(number,{ text: message } ).then(response => {
		  res.status(200).json({
			status: true,
			response: response
		  });
		}).catch(err => {
		  res.status(500).json({
			status: false,
			response: err
		  });
		});
	  });
	
	  const checkRegisteredNumber = async function(number) {
		const isRegistered = await sock.onWhatsApp(number);
		return isRegistered;
	  }
	
	
	  // Send media
	  app.post('/send-media', async (req, res) => {
		const number = req.body.number;
		const caption = req.body.caption;
		const fileUrl = req.body.file;
	
		// const number = '918733966597@s.whatsapp.net';
		// const caption = 'req.body.caption';
		// const fileUrl = 'http://res.cloudinary.com/d1pf7fgmpy/image/upload/v1680390625/rtqspezplz91rf4nh7yy.png';
	 
		sock.sendMessage(number,  {
			image: {url: fileUrl},
			caption: caption}).then(response => {
		  res.status(200).json({
			status: true,
			response: response
		  });
		}).catch(err => {
		  res.status(500).json({
			status: false,
			response: err
		  });
		});
	  });
	
	
	//   // id & people to add to the group (will throw error if it fails)
	// const response = await sock.groupParticipantsUpdate(
	//     "abcd-xyz@g.us", 
	//     ["abcd@s.whatsapp.net", "efgh@s.whatsapp.net"],
	//     "add" // replace this parameter with "remove", "demote" or "promote"
	// )
	  
	// Add Memeber
	app.get('/add-member', async (req, res) => {
		const errors = validationResult(req).formatWith(({
		  msg
		}) => {
		  return msg;
		});
	  
		if (!errors.isEmpty()) {
		  return res.status(422).json({
			status: false,
			message: errors.mapped()
		  });
		}
		// {"number":"918000789170@c.us","sender":"third","groupId":"916353594230-1585501240@g.us"}
	  const sender = 'req.body.sender';
	  const number = '918279615273@s.whatsapp.net';
	  const group = '916353594230-158550124@g.us';
	
	//   const sender = req.body.sender;
	//   const number = req.body.number;
	//   const group = req.body.groupId;
	  
	  await sock.groupParticipantsUpdate(group, [number], "add").then(response => {
		//await sock.groupCreate("My Fab Group", [number]).then(response => {
		res.status(200).json({
		  status: true,
		  response: response
		});
	  }).catch(err => {
		console.log('err: ', err);
		res.status(500).json({
		  status: false,
		  response: err
		});
	  });
	});

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if(store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}

startSock()

server.listen(port, function() {
	console.log('App running on *: ' + port);
  });