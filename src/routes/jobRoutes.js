import express from "express";
import {
	createJob,
	getJobs,
	getJobStatusCounts,
	applyToJob,
	removeJobs,
	updateJobStatus,
	unapplyFromJob,
	getJobsForRule,
	removeJobsForRule,
	analyzeJob,
	getJobSkillAnalysis,
	getJobById,
} from "../controllers/jobController.js";

const router = express.Router();

router.post('/jobs', createJob);
router.post('/jobs/list', getJobs);
router.post('/jobs/list/counts', getJobStatusCounts);
router.get('/jobs/:id', getJobById);
router.post('/jobs/:id/analyze', analyzeJob);
router.get('/jobs/:id/skill-analysis', getJobSkillAnalysis);
router.get('/jobs/rule/:name', getJobsForRule);
router.delete('/jobs/rule/:name', removeJobsForRule);
router.post('/jobs/remove', removeJobs);
router.post('/jobs/:id/apply', applyToJob);
router.post('/jobs/:id/status', updateJobStatus);
router.post('/jobs/:id/unapply', unapplyFromJob);

export default router;
