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

import { ChatGroq } from "@langchain/groq";
import {
    ChatPromptTemplate, //for prompt templates
    MessagesPlaceholder, //for gaps to be filled in later on
} from "@langchain/core/prompts";

import { StringOutputParser } from "@langchain/core/output_parsers";

import {
    InMemoryChatMessageHistory, // gives a session history
} from "@langchain/core/chat_history";

import {
    RunnableWithMessageHistory, //creates a wrraper for runnables to store memory
} from "@langchain/core/runnables";

//=======================================LLM====================================================

const model = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
    temperature: 0.7,
});

//=======================================Prompt====================================================
const prompt = ChatPromptTemplate.fromMessages([
    [
        "system",
        "You are a friendly AI assistant on WhatsApp. Keep your answers clear, helpful, and conversational.",
    ],
    
    new MessagesPlaceholder("history"),
    
    ["human", "{message}"],
]);


//=======================================Chaining====================================================
const chain= prompt.pipe(model).pipe(new StringOutputParser())

//=======================================Conversation Memory====================================================
//it is a emory that a bot remmebrs during a conversation 
const store = {};
function getSessionHistory(sessionId) {
    //if there is no session id exists in our store database, we create one and store the session history in it
    if (!store['sessiongId']){
            store[sessionId] =new InMemoryChatMessageHistory();
    }
     return store[sessionId];
}

// now we wrap it inside runnable
const chatbot = new RunnableWithMessageHistory({
    runnable:chain,
    getMessageHistory: getSessionHistory,
    inputMessagesKey: "message",
    historyMessagesKey= "history"
})





//=======================================Invoking====================================================
async function getReply(message,sessionId) {
    try {
        return await chatbot.invoke({
            message,
        },
        {
            configurable: { sessionId,},
        });

    }

    catch (error) {
        console.error(error);

        return "Sorry, something went wrong.";
    }
}

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
            const reply= await getReply(text,number) //we give phone number of sender as session ID (through this on that number we have whole conversation history)
            await socket.sendMessage(jid, {
                text: reply,
            });
        }

    })


}  

connectBot()