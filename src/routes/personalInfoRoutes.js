
import express from "express";
import {
	getSkills,
	addSkill,
	deleteSkill,
	updateSkills,
	getAutoBidProfile,
	upsertAutoBidProfile,
	updateAutoBidOpenAiModel,
	getResumeCatalog,
	upsertResumeCatalog,
	validateResumeCatalogHandler,
} from "../controllers/personalInfoController.js";
import {
	getLlmModels,
	generateResume,
	generateResumeStream,
	getGeneratorConfig,
	saveGeneratorConfig,
	listGenerations,
	getGeneration,
	checkLlmKey,
} from "../controllers/resumeGenController.js";
import { renderResumePdf } from "../controllers/resumePdfController.js";
import { renderResumeDocx } from "../controllers/resumeDocxController.js";
import {
	listUserResumesHandler,
	getUserResumeHandler,
	createUserResumeHandler,
	bulkCreateUserResumesHandler,
	setPrimaryUserResumeHandler,
	deleteUserResumeHandler,
	analyzeUserResumeHandler,
} from "../controllers/userResumeController.js";
import { analyzeResumeMatch } from "../controllers/resumeAnalysisController.js";

const router = express.Router();

router.get('/personal/skills', getSkills);
router.post('/personal/skills', addSkill);
router.delete('/personal/skills', deleteSkill);
router.post('/personal/skills/update', updateSkills);

router.get('/personal/auto-bid-profile', getAutoBidProfile);
router.put('/personal/auto-bid-profile', upsertAutoBidProfile);
router.post('/personal/auto-bid-profile/openai-model', updateAutoBidOpenAiModel);

router.get('/personal/resume-catalog', getResumeCatalog);
router.put('/personal/resume-catalog', upsertResumeCatalog);
router.post('/personal/resume-catalog/validate', validateResumeCatalogHandler);

router.get('/personal/llm-models', getLlmModels);
router.post('/personal/resume-generate', generateResume);
router.post('/personal/resume-generate/stream', generateResumeStream);
router.get('/personal/resume-generator/config', getGeneratorConfig);
router.put('/personal/resume-generator/config', saveGeneratorConfig);
router.get('/personal/resume-generations', listGenerations);
router.get('/personal/resume-generations/:id', getGeneration);
router.post('/personal/llm-key-check', checkLlmKey);
router.post('/personal/resume-pdf', renderResumePdf);
router.post('/personal/resume-docx', renderResumeDocx);

router.get('/personal/user-resumes', listUserResumesHandler);
router.get('/personal/user-resumes/:id', getUserResumeHandler);
router.post('/personal/user-resumes', createUserResumeHandler);
router.post('/personal/user-resumes/bulk', bulkCreateUserResumesHandler);
router.put('/personal/user-resumes/:id/primary', setPrimaryUserResumeHandler);
router.post('/personal/user-resumes/:id/analyze', analyzeUserResumeHandler);
router.delete('/personal/user-resumes/:id', deleteUserResumeHandler);
router.post('/personal/resume-analysis', analyzeResumeMatch);

export default router;
