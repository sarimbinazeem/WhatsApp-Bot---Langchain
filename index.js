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

import fs from "fs/promises"; //to read knowledge.txt
 
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"; //to create chunks of text

import { MemoryVectorStore } from "langchain/vectorstores/memory";  //to store vector embeddings

//=======================================LLM====================================================

const model = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
    temperature: 0.7,
});

//=======================================Embedding====================================================
import { pipeline } from "@xenova/transformers";

let extractor;

async function getEmbeddingModel() {

    if (!extractor) {

        extractor = await pipeline(
            "feature-extraction",
            "Xenova/all-MiniLM-L6-v2"
        );

    }

    return extractor;
}

//for langchain we need to create embedDocuments and mebd query fucntion explciity in javascript
const embeddings = {

    async embedDocuments(texts) {

        const model = await getEmbeddingModel();

        const vectors = [];

        for (const text of texts) {

            const output = await model(text, {
                pooling: "mean",
                normalize: true,
            });

            vectors.push(Array.from(output.data));

        }

        return vectors;
    },

    async embedQuery(text) {

        const model = await getEmbeddingModel();

        const output = await model(text, {
            pooling: "mean",
            normalize: true,
        });

        return Array.from(output.data);
    },

};

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
    if (!store[sessionId]){
            store[sessionId] =new InMemoryChatMessageHistory();
    }
     return store[sessionId];
}

// now we wrap it inside runnable
const chatbot = new RunnableWithMessageHistory({
    runnable:chain,
    getMessageHistory: getSessionHistory,
    inputMessagesKey: "message",
    historyMessagesKey: "history"
})

//=======================================Personal Memory====================================================
//It is that memory that the bot automaically extracts and save it. It extracts the important information that belongs to user personal information
const personalMemory = {};
//under a number's sessionID the number's user's personal information is stored as memory

//Prompt to EXTRACT personal information
const memoryPrompt = ChatPromptTemplate.fromMessages([
    [
        "system",
        `Extract any personal information from the user's message.

            Return ONLY valid JSON.

            Possible fields include:
            - name
            - age
            - city
            - profession
            - hobbies
            - favorite_food
            - favorite_color
            - preferences

            If nothing personal is found return {}.

            Do not explain anything.`,
    ],

    ["human", "{message}"],
]);
const memoryChain = memoryPrompt.pipe(model).pipe(new StringOutputParser());

async function updatePersonalMemory(message,sessionId){
    try{
        const result= await memoryChain.invoke({message,})
        
        //parse the json 
        const text= JSON.parse(result)

        //If there is no personaly memory of this sessionID then create one
        if (!personalMemory[sessionId]) {

            personalMemory[sessionId] = {};  //We dont store inMessageHistory() here because we want to store only the PERSONAL info not the whole chat

        }        

        //this merges the previous history with a new information
        Object.assign(

            personalMemory[sessionId],

            text

        );

    }
    catch (error) {

        console.log("Memory extraction failed.");

    }
}


//We give the bot the psosible attribtues that you shoudl find and give the result in JSON format




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

            await updatePersonalMemory(text,number );

            const lower = text.toLowerCase();

            //if the message is any of those tehn call the personal memory
            if (
                lower.includes("who am i") ||
                lower.includes("what do you know about me") ||
                lower.includes("what do you remember about me") ||
                lower.includes("list everything you remember about me")
            ) {
                const memory = personalMemory[number];

                //if for that sessionID we dont find any memory then we pirn that
                if (!memory || Object.keys(memory).length === 0) {
                    await socket.sendMessage(jid, {
                        text: "I don't know anything about you yet.",
                    });

                    continue;
                }          
                
 
                let reply = "Here's what I know about you:\n\n";

                for (const key in memory) {
                    reply += `• ${key}: ${memory[key]}\n`;
                }   

                await socket.sendMessage(jid, {
                    text: reply,
                });            

                continue

            }

            //bot send message
            const reply= await getReply(text,number) //we give phone number of sender as session ID (through this on that number we have whole conversation history)
            await socket.sendMessage(jid, {
                text: reply,
            });
        }

    })


}  

connectBot()