const { MongoClient } = require('mongodb');
require('dotenv').config();

const client = new MongoClient(process.env.MONGO_URI);

async function main() {
    try {
        await client.connect();

        console.log('Connected to MongoDB Atlas!');

        const db = client.db('college');
        const students = db.collection('students');

        const result = await students.insertOne({
            name: 'Harshal',
            usn: '4MW24AI018',
            branch: 'AIML',
            cgpa: 8.7
        });

        console.log('Student inserted:', result.insertedId);

        const records = await students.find().toArray();

        console.log('All students:', records);

        const updateResult = await students.updateOne(
            { usn: '4MW24AI018' },
            { $set: { cgpa: 9.0 } }
        );

        console.log('Updated records:', updateResult.modifiedCount);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.close();
    }
}

main();