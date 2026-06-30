const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            maxPoolSize: 10,                  // allow up to 10 concurrent connections
            serverSelectionTimeoutMS: 5000,   // fail fast if MongoDB unreachable
            socketTimeoutMS: 45000,           // drop idle sockets after 45 s
            bufferCommands: false,            // disable query buffering when disconnected
        });
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err.message);
        throw err;
    }
};

module.exports = connectDB;
