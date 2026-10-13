const PmsSetting = require('./models/pmsSetting.model');
const { DEFAULT_RATING_BANDS_5 } = require('./services/pmsScoring.service');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { DEFAULT_WORKFLOW_STAGES } = require('./services/pmsWorkflow.service');

/**
 * @desc Get company PMS settings (creates defaults if missing)
 * @route GET /api/performance/settings
 */
const getPmsSettings = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?.companyId;
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company ID is required' });
    }

    let settings = await PmsSetting.findOne({ companyId }).lean();

    if (!settings) {
      try {
        settings = await PmsSetting.create({
          companyId,
          ratingScales: [
            {
              name: 'Standard 5-Point Rating Scale',
              scaleType: '1-5',
              isDefault: true,
              bands: DEFAULT_RATING_BANDS_5,
            },
          ],
          defaultWeightageModel: {
            kraWeight: 40,
            kpiWeight: 20,
            goalWeight: 20,
            competencyWeight: 20,
          },
          bellCurveTargetDistribution: [
            { label: 'Exceptional Performance', targetPercentage: 10 },
            { label: 'Exceeds Expectations', targetPercentage: 20 },
            { label: 'Meets Expectations', targetPercentage: 50 },
            { label: 'Partially Meets Expectations', targetPercentage: 15 },
            { label: 'Significantly Below Expectations', targetPercentage: 5 },
          ],
          approvalWorkflow: {
            stages: DEFAULT_WORKFLOW_STAGES,
            allowRevisions: true,
            rejectionBehavior: 'return_to_employee',
          },
          continuousFeedbackSettings: {
            allowPeerRecognition: true,
            publicWallEnabled: true,
            anonymousFeedbackDefault: true,
            minResponsesForDisclosure: 3,
            allowEmployeeNominate360: true,
            requireManagerApprovalFor360: true,
          },
        });
      } catch (createErr) {
        if (createErr.code === 11000) {
          settings = await PmsSetting.findOne({ companyId }).lean();
        } else {
          throw createErr;
        }
      }
    }

    return res.status(200).json({ success: true, data: settings });
  } catch (err) {
    console.error('[PMS getPmsSettings Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch PMS settings', error: err.message });
  }
};

/**
 * @desc Update company PMS settings
 * @route PUT /api/performance/settings
 */
const updatePmsSettings = async (req, res) => {
  try {
    const { ratingScales, defaultWeightageModel, bellCurveTargetDistribution, continuousFeedbackSettings, approvalWorkflow } = req.body;

    const companyId = req.companyId || req.user?.companyId;
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company ID is required' });
    }

    let settings = await PmsSetting.findOne({ companyId });
    if (!settings) {
      settings = new PmsSetting({ companyId });
    }

    if (ratingScales) settings.ratingScales = ratingScales;
    if (defaultWeightageModel) settings.defaultWeightageModel = defaultWeightageModel;
    if (bellCurveTargetDistribution) settings.bellCurveTargetDistribution = bellCurveTargetDistribution;
    if (continuousFeedbackSettings) settings.continuousFeedbackSettings = continuousFeedbackSettings;
    if (approvalWorkflow) settings.approvalWorkflow = approvalWorkflow;

    settings.updatedBy = req.user._id;
    await settings.save();

    await logPmsAudit({
      companyId,
      userId: req.user._id,
      action: 'PMS_SETTINGS_UPDATED',
      entityType: 'PmsSetting',
      changes: req.body,
    });

    return res.status(200).json({ success: true, message: 'PMS settings updated successfully', data: settings });
  } catch (err) {
    console.error('[PMS updatePmsSettings Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update PMS settings' });
  }
};

module.exports = {
  getPmsSettings,
  updatePmsSettings,
};
