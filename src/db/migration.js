
import { MongoClient } from "mongodb";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function migrate() {
	const mongoUrl = process.env.MONGO_URL;
	if(mongoDbName) {
		console.log('MongoDB database name is set to ', mongoDbName);
	} else {
		console.log('MongoDB database name is not set, using default database name');
	}
	const client = new MongoClient(mongoUrl);

	try {
		await client.connect();
		console.log('Connected to MongoDB for migration');

		const db = client.db(mongoDbName);
		const jobsCollection = db.collection('job_market');
		const accountInfoCollection = db.collection('account_info');

		const applier = await accountInfoCollection.findOne({ name: "Jeffrey Yuan" });

		if (!applier) {
			console.error("Could not find user 'Jeffrey Yuan' in account_info collection. Aborting migration.");
			return;
		}

		const applierId = applier._id;
		console.log(`Found applier 'Jeffrey Yuan' with _id: ${applierId}`);

		const cursor = jobsCollection.find({ "status": { "$type": "object" } });

		let updatedCount = 0;
		while (await cursor.hasNext()) {
			const job = await cursor.next();
			const oldStatus = job.status;

			if (typeof oldStatus === 'object' && oldStatus !== null && !Array.isArray(oldStatus)) {
				const newStatus = [{
					applier: applierId,
					...oldStatus
				}];

				await jobsCollection.updateOne(
					{ _id: job._id },
					{ $set: { status: newStatus } }
				);
				updatedCount++;
				console.log(`Updated job with id: ${job._id}`);
			}
		}

		console.log(`Migration completed. Updated ${updatedCount} documents.`);

	} catch (err) {
		console.error('Migration failed:', err);
	} finally {
		await client.close();
		console.log('MongoDB connection closed.');
	}
}

migrate();
