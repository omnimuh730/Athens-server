import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import bcrypt from "bcrypt";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function migratePasswords() {
	const mongoUrl = process.env.MONGO_URL;
	const mongoDbName = process.env.MONGO_DB;
	if(mongoDbName) {
		console.log('MongoDB database name is set to ', mongoDbName);
	} else {
		console.log('MongoDB database name is not set, using default database name');
	}
	const client = new MongoClient(mongoUrl);

	try {
		await client.connect();
		console.log('Connected to MongoDB for password migration');

		const db = client.db(mongoDbName);
		const accountInfoCollection = db.collection('account_info');

		// Find all users without passwords
		const usersWithoutPassword = await accountInfoCollection.find({ 
			password: { $exists: false } 
		}).toArray();

		console.log(`Found ${usersWithoutPassword.length} users without passwords`);

		if (usersWithoutPassword.length === 0) {
			console.log('No users need password migration');
			return;
		}

		// Default password
		const defaultPassword = "12345678";
		const hashedPassword = await bcrypt.hash(defaultPassword, 10);

		// Update all users without passwords
		let updatedCount = 0;
		for (const user of usersWithoutPassword) {
			await accountInfoCollection.updateOne(
				{ _id: user._id },
				{ $set: { password: hashedPassword } }
			);
			updatedCount++;
			console.log(`Updated password for user: ${user.name}`);
		}

		console.log(`Password migration completed. Updated ${updatedCount} users with default password: ${defaultPassword}`);

	} catch (err) {
		console.error('Password migration failed:', err);
	} finally {
		await client.close();
		console.log('MongoDB connection closed.');
	}
}

migratePasswords();

