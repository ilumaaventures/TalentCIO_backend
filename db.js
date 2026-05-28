const mongoose = require('mongoose');
// Trigger restart


const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err.message);
        throw err;
    }
};


module.exports = connectDB;
