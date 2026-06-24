import express from 'express';
import { ObjectId } from 'mongodb';
import { accountInfoCollection, jobsCollection } from '../db/mongo.js';
import { createAsyncHandler } from '../utils/http.js';

const router = express.Router();

/** Read-only profiles for connector deploy UI. */
router.get(
  '/internal/connector/profiles',
  createAsyncHandler(async (_req, res) => {
    if (!accountInfoCollection) {
      return res.status(503).json({ success: false, error: 'Database not ready' });
    }
    const docs = await accountInfoCollection
      .find({}, { projection: { password: 0 } })
      .sort({ name: 1 })
      .toArray();
    const profiles = docs.map((d) => ({
      id: String(d._id),
      name: d.name,
      autoBidProfile: d.autoBidProfile || null,
      resumeCatalog: d.resumeCatalog || {},
    }));
    res.json({ success: true, profiles });
  }),
);

router.get(
  '/internal/connector/profiles/:id',
  createAsyncHandler(async (req, res) => {
    if (!accountInfoCollection) {
      return res.status(503).json({ success: false, error: 'Database not ready' });
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid profile id' });
    }
    const doc = await accountInfoCollection.findOne(
      { _id: new ObjectId(req.params.id) },
      { projection: { password: 0 } },
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Profile not found' });
    res.json({ success: true, profile: doc });
  }),
);

/** Posted jobs for connector batch deploy (not yet applied by applier). */
router.get(
  '/internal/connector/jobs/posted',
  createAsyncHandler(async (req, res) => {
    if (!jobsCollection) {
      return res.status(503).json({ success: false, error: 'Database not ready' });
    }
    const applierId = String(req.query.applierId || '').trim();
    const source = String(req.query.source || '').trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const skip = Math.max(0, Number(req.query.skip) || 0);

    const and = [
      {
        $or: [
          { applyLink: { $regex: /^https?:\/\//i } },
          { url: { $regex: /^https?:\/\//i } },
        ],
      },
    ];
    if (applierId && ObjectId.isValid(applierId)) {
      const oid = new ObjectId(applierId);
      and.push({
        $or: [
          { status: { $exists: false } },
          { status: { $not: { $elemMatch: { applier: oid } } } },
        ],
      });
    }
    if (source && source !== 'All') and.push({ source });

    const query = and.length === 1 ? and[0] : { $and: and };
    const docs = await jobsCollection
      .find(query, {
        projection: {
          title: 1,
          company: 1,
          url: 1,
          applyLink: 1,
          source: 1,
          skills: 1,
          skillsNormalized: 1,
          status: 1,
        },
      })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({
      success: true,
      jobs: docs.map((d) => ({
        id: String(d._id),
        title: d.title,
        company: d.company,
        url: d.applyLink || d.url,
        source: d.source,
        skills: d.skills || [],
      })),
    });
  }),
);

export default router;
