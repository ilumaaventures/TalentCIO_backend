const mongoose = require('mongoose');

async function fixTasks() {
  await mongoose.connect('mongodb://127.0.0.1:27017/talentcio');
  const db = mongoose.connection;
  await db.collection('tasks').updateOne(
    { _id: new mongoose.Types.ObjectId('6ab77051a4aae78e517d6c2b') },
    { $set: { module: new mongoose.Types.ObjectId('6ab77009a4aae78e517d6c01') } }
  );
  await db.collection('tasks').updateOne(
    { _id: new mongoose.Types.ObjectId('6ab7705ea4aae78e517d6c46') },
    { $set: { module: new mongoose.Types.ObjectId('6ab7701fa4aae78e517d6c0f') } }
  );
  await db.collection('tasks').updateOne(
    { _id: new mongoose.Types.ObjectId('6ab7707da4aae78e517d6c61') },
    { $set: { module: new mongoose.Types.ObjectId('6ab77034a4aae78e517d6c1a') } }
  );
  await db.collection('tasks').updateOne(
    { _id: new mongoose.Types.ObjectId('6ab7714aa4aae78e517d6cc4') },
    { $set: { module: new mongoose.Types.ObjectId('6ab77034a4aae78e517d6c1a') } }
  );
  console.log('Tasks successfully moved to their correct modules!');
  
  const tasks = await db.collection('tasks').find({}).toArray();
  console.log('Current tasks and modules:');
  for (const t of tasks) {
    const mod = await db.collection('modules').findOne({ _id: t.module });
    console.log(`Task "${t.name}" -> Module "${mod?.name}"`);
  }

  process.exit(0);
}

fixTasks().catch(console.error);
