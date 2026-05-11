const mongoose = require('mongoose');
require('dotenv').config();

const MODELS = [
    require('../src/models/Project'),
    require('../src/models/Module'),
    require('../src/models/Task'),
    require('../src/models/WorkLog'),
    require('../src/models/Candidate'),
    require('../src/models/User'),
    require('../src/models/Role'),
    require('../src/models/Client'),
    require('../src/models/BusinessUnit'),
    require('../src/models/Discussion'),
    require('../src/models/Meeting'),
    require('../src/models/Holiday'),
    require('../src/models/ApprovalWorkflow'),
    require('../src/models/InterviewWorkflow'),
    require('../src/models/LeaveConfig'),
    require('../src/models/QueryType'),
    require('../src/models/HiringRequest').HiringRequest
];

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    for (const Model of MODELS) {
        const result = await Model.updateMany(
            { isDeleted: { $exists: false } },
            { $set: { isDeleted: false, deletedAt: null, deletedBy: null } }
        );

        console.log(`${Model.modelName}: updated ${result.modifiedCount ?? result.modified || 0} records`);
    }

    await mongoose.disconnect();
    console.log('Done');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
