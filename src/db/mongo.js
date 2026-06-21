
import { MongoClient } from "mongodb";
import { ensureJobMarketIndexes, backfillMissingJobSourceFields } from "../services/jobMarketIndexes.js";

let mongoClient;
let mongoCloudClient;
let jobsCollection;
let companyCategoryCollection;
let personalInfoCollection;
let accountInfoCollection;
/** Cloud mirror of `account_info` — writes/deletes are applied here too when configured. */
let accountInfoCloudCollection;
let cloudMirrorConfigured = false;
let cloudMirrorConnectError = null;
let rulesCollection;
let bidRecordsCollection;
let bidRecordsLocalCollection;
let bidRecordsCloudCollection;
let skillEnrichmentQueueCollection;
let skillCooccurrenceCollection;
let userKnowledgeGraphsCollection;
// Resume generator: saved config per applier + a history of generation runs.
// Always local (AIMS_local) — this is the user's working data.
let resumeGeneratorConfigCollection;
let resumeGenerationsCollection;
let mailMessagesCollection;
let mailSyncStateCollection;
let mailUserLabelsCollection;
let userResumesCollection;

async function ensureMailCollectionsIndexes() {
	if (mailMessagesCollection) {
		// UID is unique per IMAP mailbox, not globally — include mailbox in the key.
		try {
			await mailMessagesCollection.dropIndex('applierName_1_uid_1');
		} catch {
			// Index may not exist on fresh DBs.
		}
		await mailMessagesCollection.createIndex(
			{ applierName: 1, mailbox: 1, uid: 1 },
			{ unique: true },
		);
		await mailMessagesCollection.createIndex({ applierName: 1, date: -1 });
		await mailMessagesCollection.createIndex({ applierName: 1, folder: 1, date: -1 });
	}
	if (mailSyncStateCollection) {
		await mailSyncStateCollection.createIndex({ applierName: 1 }, { unique: true });
	}
	if (mailUserLabelsCollection) {
		await mailUserLabelsCollection.createIndex({ applierName: 1 }, { unique: true });
	}
}

async function ensureSkillCollectionsIndexes() {
	if (skillEnrichmentQueueCollection) {
		await skillEnrichmentQueueCollection.createIndex({ normalizedKey: 1 }, { unique: true });
		await skillEnrichmentQueueCollection.createIndex({ status: 1, createdAt: 1 });
	}
	if (skillCooccurrenceCollection) {
		await skillCooccurrenceCollection.createIndex({ pairKey: 1 }, { unique: true });
		await skillCooccurrenceCollection.createIndex({ count: -1 });
	}
	if (personalInfoCollection) {
		await personalInfoCollection.createIndex({ name: 1 }, { unique: true });
		await personalInfoCollection.createIndex({ canonicalId: 1 });
	}
	if (userKnowledgeGraphsCollection) {
		await userKnowledgeGraphsCollection.createIndex({ applierName: 1, resumeId: 1 }, { unique: true });
		await userKnowledgeGraphsCollection.createIndex({ applierName: 1, updatedAt: -1 });
	}
	if (userResumesCollection) {
		await userResumesCollection.createIndex({ ownerId: 1, techStack: 1 });
		await userResumesCollection.createIndex({ ownerName: 1, uploadedAt: -1 });
		await userResumesCollection.createIndex({ ownerName: 1, analyzed: 1 });
	}
	if (jobsCollection) {
		await jobsCollection.createIndex({ 'skillAnalysis.status': 1, 'skillAnalysis.queuedAt': 1 });
	}
}

async function initMongo() {
	const mongoUrl = process.env.MONGO_URL;
	if (!mongoUrl) {
		throw new Error(
			'MONGO_URL is not set. Copy .env.example to .env and set MONGO_URL (e.g. mongodb://127.0.0.1:27017).'
		);
	}
	const mongoDbName = process.env.MONGO_DB || 'AIMS_local';
	mongoClient = new MongoClient(mongoUrl);
	await mongoClient.connect();
	const db = mongoClient.db(mongoDbName);
	jobsCollection = db.collection('job_market');
	companyCategoryCollection = db.collection('company_category');
	personalInfoCollection = db.collection('personal_info');
	skillEnrichmentQueueCollection = db.collection('skill_enrichment_queue');
	skillCooccurrenceCollection = db.collection('skill_cooccurrence');
	userKnowledgeGraphsCollection = db.collection('user_knowledge_graphs');
	accountInfoCollection = db.collection('account_info');
	rulesCollection = db.collection('rules');
	resumeGeneratorConfigCollection = db.collection('resume_generator_config');
	resumeGenerationsCollection = db.collection('resume_generations');
	mailMessagesCollection = db.collection('mail_messages');
	mailSyncStateCollection = db.collection('mail_sync_state');
	mailUserLabelsCollection = db.collection('mail_user_labels');
	userResumesCollection = db.collection('user_resumes');
	await ensureJobMarketIndexes(jobsCollection);
	await ensureSkillCollectionsIndexes();
	await ensureMailCollectionsIndexes();
	void backfillMissingJobSourceFields(jobsCollection).catch((err) => {
		console.warn('[job_market] source field backfill failed', err.message);
	});
	console.log('Connected to MongoDB', mongoUrl, 'DB:', mongoDbName);

	let bidRecordsSource = 'local';
	bidRecordsLocalCollection = db.collection('bid_records');
	bidRecordsCollection = bidRecordsLocalCollection;

	const mongoCloudUrl = process.env.MONGO_CLOUD_URL?.trim();
	if (mongoCloudUrl) {
		cloudMirrorConfigured = true;
		try {
			mongoCloudClient = new MongoClient(mongoCloudUrl);
			await mongoCloudClient.connect();
			const cloudDb = mongoCloudClient.db(mongoDbName);
			accountInfoCloudCollection = cloudDb.collection('account_info');
			bidRecordsCloudCollection = cloudDb.collection('bid_records');
			bidRecordsCollection = bidRecordsCloudCollection;
			bidRecordsSource = 'cloud';
			console.log('Connected to cloud MongoDB (account_info mirror + bid_records reads)', mongoDbName);
		} catch (err) {
			cloudMirrorConnectError = err instanceof Error ? err.message : String(err);
			console.error('Cloud MongoDB connection failed — account_info will save locally only until fixed:', cloudMirrorConnectError);
			console.error('Vendor Monitor bid_records require cloud MongoDB — bid sessions will be unavailable until fixed.');
			if (mongoCloudClient) {
				try {
					await mongoCloudClient.close();
				} catch {
					// ignore
				}
				mongoCloudClient = null;
			}
			accountInfoCloudCollection = null;
			bidRecordsCloudCollection = null;
			bidRecordsCollection = bidRecordsLocalCollection;
		}
	} else {
		console.log('MONGO_CLOUD_URL not set — account_info writes go to local only; bid_records read from local');
	}

	console.log(`Vendor Monitor bid_records source: ${bidRecordsSource}`);
}

function getBidRecordsCollection(source = 'cloud') {
	const normalized = source === 'local' ? 'local' : 'cloud';
	const collection = normalized === 'local' ? bidRecordsLocalCollection : bidRecordsCloudCollection;
	if (!collection) {
		return {
			source: normalized,
			collection: null,
			error:
				normalized === 'cloud'
					? cloudMirrorConnectError || 'Cloud MongoDB is not connected. Set MONGO_CLOUD_URL and restart lancer-backend.'
					: 'Local MongoDB is not connected.',
		};
	}
	return { source: normalized, collection, error: null };
}

function isCloudMirrorConfigured() {
	return cloudMirrorConfigured;
}

function getCloudMirrorStatus() {
	return {
		configured: cloudMirrorConfigured,
		connected: Boolean(accountInfoCloudCollection),
		error: cloudMirrorConnectError,
	};
}

async function closeMongo() {
	if (mongoClient) {
		await mongoClient.close();
		mongoClient = null;
	}
	if (mongoCloudClient) {
		await mongoCloudClient.close();
		mongoCloudClient = null;
	}
	accountInfoCloudCollection = null;
	bidRecordsCollection = null;
	bidRecordsLocalCollection = null;
	bidRecordsCloudCollection = null;
	cloudMirrorConfigured = false;
	cloudMirrorConnectError = null;
}

export {
	initMongo,
	jobsCollection,
	companyCategoryCollection,
	personalInfoCollection,
	skillEnrichmentQueueCollection,
	skillCooccurrenceCollection,
	userKnowledgeGraphsCollection,
	accountInfoCollection,
	accountInfoCloudCollection,
	isCloudMirrorConfigured,
	getCloudMirrorStatus,
	getBidRecordsCollection,
	rulesCollection,
	bidRecordsCollection,
	bidRecordsLocalCollection,
	bidRecordsCloudCollection,
	resumeGeneratorConfigCollection,
	resumeGenerationsCollection,
	mailMessagesCollection,
	mailSyncStateCollection,
	mailUserLabelsCollection,
	userResumesCollection,
	closeMongo
};
