//=======================================Imports====================================================

import "dotenv/config"

import pino from "pino" // to ignore the logs that bailey creates
import QRCode from "qrcode" //When we first connect to wahtsapp it gives a qrcode which we will dipslya in terminal

import makeWASocket , {useMultiFileAuthState, fetchLatestWaWebVersion,DisconnectReason, downloadMediaMessage} from "baileys"

//makeWASocket -> it creates a connection to whatsapp
//QR Code is sent everytime for AUTHORIZATION. We can fix this by using useMultiFileAuthState() -> it saves the login 
// to avoid version issues we use fetchLatestWaWebVersion()
//If there is a disconnect for some reason -> DisconnectReason will let us know 


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

import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";  //to store vector embeddings

import { pipeline } from "@xenova/transformers";
import { GoogleGenAI } from "@google/genai";

//=======================================LLM====================================================

const model = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
    temperature: 0.7,
});

//=======================================Gemini====================================================
const gemini = new GoogleGenAI(
    {
        apiKey: process.env.GEMINI_API_KEY,
    } 
)

//=======================================Embedding====================================================

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

//=======================================RAG====================================================
let retriever;
let vectorStore;

async function initliazeRAG() {
    console.log("Loading Knowledge Base...");

    //reading the knwoledge.txt
    const knowledge = await fs.readFile(
        "knowledge.txt",
        "utf-8"
    )

    //Chunking
    const splitter = new RecursiveCharacterTextSplitter(
        {
            chunkSize: 500,
            chunkOverlap: 50,
        }
    )

    //create documents of that chunks
    const documents = await splitter.createDocuments([
        knowledge,
    ])

     console.log(`Created ${documents.length} chunks.`);

     //store in vector database

    vectorStore = await MemoryVectorStore.fromDocuments(documents,embeddings);

    //creating reteiver that gives top 3 most relevant

    retriever = vectorStore.asRetriever({ k: 3, });

    console.log("Knowledge Base Loaded!");

}

//=======================================RAG Prompt====================================================
const ragPrompt = ChatPromptTemplate.fromMessages([
    [
        "system",
        `You are a friendly AI assistant on WhatsApp.

        You have access to a retrieved knowledge base.

        Rules:
        - First, check whether the retrieved context contains information relevant to the user's question.
        - If it does, answer using that information.
        - If the context does not answer the question, answer using your own general knowledge.
        - Never make up or contradict information found in the retrieved context.
        - If the user asks about the owner of this bot (Sarim), his projects, skills, education, experience, or anything related to him, always prioritize the retrieved context.
        - Use previous conversation history when it helps answer the user.
        - Keep responses natural, conversational, and concise.
        - If the answer is unknown and neither the context nor your knowledge contains it, simply say you don't know.

        Retrieved Context:
        {context}`
            ],

    new MessagesPlaceholder("history"),

    ["human", "{message}"],
]);


//=======================================Chaining====================================================
const ragChain = ragPrompt.pipe(model).pipe(new StringOutputParser());

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


const ragBot = new RunnableWithMessageHistory({

    runnable: ragChain,

    getMessageHistory: getSessionHistory,

    inputMessagesKey: "message",

    historyMessagesKey: "history",

});
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

            If nothing personal is found return  {{}}.

            Do not explain anything.`,
    ],

    ["human", "{message}"],
]);
const memoryChain = memoryPrompt.pipe(model).pipe(new StringOutputParser());

async function updatePersonalMemory(message,sessionId){
    try{
        const result= await memoryChain.invoke({message,})
        console.log(result);
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
        console.error(error);
    }
}


//We give the bot the psosible attribtues that you shoudl find and give the result in JSON format




//=======================================Invoking====================================================


async function getRAGReply(message,sessionId){
    try{
        const docs = await retriever.invoke(message)

        const context = docs.map((doc, index) =>
                                `Document ${index + 1}\n${doc.pageContent}`
                            ).join("\n\n");

        return await ragBot.invoke(
                            {
                                message,
                                context,
                            },
                            {
                                configurable: {
                                    sessionId,
                                },
                            }
                        );
    }
    catch (error) {

        console.error(error);

        return "Sorry, something went wrong.";

    }
}

async function getImageReply(buffer,mimeType,caption=""){
    try
    {
        const image = buffer.toString("base64");  //So that gemini understands the image

        const response = await gemini.models.generateContent({
            model: "gemini-flash-lite-latest",

            contents:[
                {
                    inlineData:{
                        mimeType: mimeType,
                        data:image,
                    },
                },
                {
                    text: `
                    File MIME Type:
                    ${mimeType}

                    Caption:
                    ${caption}

                    Analyze this uploaded file.

                    If the uploaded file is:
                    - image -> analyze it
                    - document -> summarize it
                    - video -> explain it
                    - audio -> transcribe it and answer the user's question

                    ...
                    `
                }

            ]
        })

        return response.text
    }
     catch (err) {

        console.error(err);

        return "Sorry, I couldn't analyze the image.";

    }    
}


//=======================================Baileys====================================================
//creating asynchronous function that starts connection (making it async because loading authorization, connection, downloading whatsapp version takes time so we don want to wait our program for that)
async function connectBot(){
    await initliazeRAG();
    
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
            await QRCode.toFile("qr.png", qr);
            console.log("QR saved as qr.png");
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
            
            if(msg.message?.imageMessage){
                const caption = msg.message.imageMessage.caption ?? "";

                const buffer = await downloadMediaMessage(
                    msg,
                    "buffer",
                    {},
                    {
                        logger: pino(),
                        reuploadRequest: socket.updateMediaMessage,
                    }
                )

                if (!buffer) {
                    await socket.sendMessage(jid, {
                        text: "Couldn't download the image.",
                    });
                    continue;
                }
                
                const mimeType = msg.message.imageMessage.mimetype
                const reply = await getImageReply(buffer,mimeType,caption)
                
                await socket.sendMessage(
                    jid,{
                        text:reply
                    }
                )
                
                continue
            }
            
            if (msg.message?.documentMessage) {
                const caption = msg.message.documentMessage.caption ?? "";
                const buffer = await downloadMediaMessage(
                    msg,
                    "buffer",
                    {},
                    {
                        logger: pino(),
                        reuploadRequest: socket.updateMediaMessage,
                    }
                );
                if (!buffer) {
                    await socket.sendMessage(jid, {
                        text: "Couldn't download the image.",
                    });
                    continue;
                }
                
                const mimeType = msg.message.documentMessage.mimetype;
                
                const reply = await getImageReply(buffer, mimeType,caption);
                
                await socket.sendMessage(jid, {
                    text: reply,
                });
                
                continue;
            }
            
            if (msg.message?.videoMessage) {
                const caption = msg.message.videoMessage.caption ?? "";
                const buffer = await downloadMediaMessage(
                    msg,
                    "buffer",
                    {},
                    {
                        logger: pino(),
                        reuploadRequest: socket.updateMediaMessage,
                    }
                );
                if (!buffer) {
                    await socket.sendMessage(jid, {
                        text: "Couldn't download the image.",
                    });
                    continue;
                }
                
                const mimeType = msg.message.videoMessage.mimetype;
                
                const reply = await getImageReply(buffer, mimeType,caption);
                
                await socket.sendMessage(jid, {
                    text: reply,
                });
                
                continue;
            }           
            
            if (msg.message?.audioMessage) {
                
                const buffer = await downloadMediaMessage(
                    msg,
                    "buffer",
                    {},
                    {
                        logger: pino(),
                        reuploadRequest: socket.updateMediaMessage,
                    }
                );
                
                if (!buffer) {
                    await socket.sendMessage(jid, {
                        text: "Couldn't download the image.",
                    });
                    continue;
                }
                const mimeType = msg.message.audioMessage.mimetype;

                const reply = await getImageReply(buffer, mimeType);

                await socket.sendMessage(jid, {
                    text: reply,
                });

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
                
 
                let reply = await getRAGReply(text, number);

                for (const key in memory) {
                    reply += `• ${key}: ${memory[key]}\n`;
                }   

                await socket.sendMessage(jid, {
                    text: reply,
                });            

                continue

            }

            //bot send message
            const reply = await getRAGReply(text, number); //we give phone number of sender as session ID (through this on that number we have whole conversation history)
            await socket.sendMessage(jid, {
                text: reply,
            });
        }

    })


}  

connectBot()