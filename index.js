//=======================================Imports====================================================

import "dotenv/config"

import pino from "pino" // to ignore the logs that bailey creates
import QRCode from "qrcode" //When we first connect to wahtsapp it gives a qrcode which we will dipslya in terminal

import makeWASocket , {useMultiFileAuthState, fetchLatestWaWebVersion,DisconnectReason} from "baileys"

//makeWASocket -> it creates a connection to whatsapp
//QR Code is sent everytime for AUTHORIZATION. We can fix this by using useMultiFileAuthState() -> it saves the login 
// to avoid version issues we use fetchLatestWaWebVersion()
//If there is a disconnect for some reason -> DisconnectReason will let us know 

import Boom from "@hapi/boom";

//=======================================Baileys====================================================
//creating asynchronous function that starts connection (making it async because loading authorization, connection, downloading whatsapp version takes time so we don want to wait our program for that)
async function connectBot(){
    //For Authorization:
    const {state, saveCreds} = await useMultiFileAuthState("auth_info_baileys")
    //it saves our login info and creditentials in auth_info_bailey so we dont have to login again and again

    //Fetching Version for our bot 
    const {version} = await fetchLatestWaWebVersion()

    //Creating our bot

    const socket = makeWASocket(
        {
            auth:state,
            version, //use the version we fetched
            logger: pino({level:"silent"}) //pilo removes all the logging noise
        }
    )

    //if the creditientials are changed then save it
    socket.ev.on("creds.update", saveCreds);

    //if there are any connection changes then send an update
    socket.ev.on("connection.update",async(update) => {
        const {connection, lastDisconnect, qr} = update
        //if there is a QR then place it on terminal
        if(qr)
        {
            console.log(await QRCode.toString(qr, {
                type:"terminal",
                small:true,
            }))
        }
    
        //if connected then print  that w eare conneted
        if (connection === "open") {
            console.log("Bot Connected!");
        }
    
        if (connection === "close") {
            // if the error code doesnt matched with logged out code then it  means there is an error -> need of reconnecting
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !==  DisconnectReason.loggedOut;
            if (shouldReconnect) {
            connectBot();
            }
    
        }   
    })

    //If there is an message then run this
    socket.ev.on("messages.upsert",async({messages}) => {
        //loop incase if there are many messages
        for (const msg of messages) {
            // get id of message
            const jid = msg.key.remoteJid;

            //if the message is from a group then ignroe
            const isGroup = jid?.endsWith("@g.us");

            //ignore statuses
            const isStatus = jid === "status@broadcast";
            
            //ignore any emssage sent by me as well

            if (msg.key.fromMe || isGroup || isStatus) {
                continue;
            }

            const text =msg.message?.conversation ||  msg.message?.extendedTextMessage?.text;

            // if the text is sticker or gift that text will be none
            if (!text) {
                continue;
            }

            //getting sender number
            const number = (msg.key.remoteJidAlt || jid)?.split("@")[0]

            console.log(`Message from: ${number}`);
            console.log(`Message: ${text}`);

            //bot send message
            await socket.sendMessage(jid, {
                text: `You said: ${text}`
            });
        }

    })


}  

connectBot()