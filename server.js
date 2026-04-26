const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    socket.on('message', (msg) => {
        io.emit('message', msg); // Пересылает сообщение всем
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running'));
