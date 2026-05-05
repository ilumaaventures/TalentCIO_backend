require('dotenv').config();
const connectDB = require('../db');
const Company = require('../src/models/Company');
const PhaseTemplate = require('../src/models/PhaseTemplate');
const { validateAndSanitizePhases } = require('../src/utils/phaseTemplateUtils');

const buildDefaultTemplatePhases = () => validateAndSanitizePhases([
    {
        name: 'Initial Screening',
        description: 'Initial recruiter review and qualification.',
        order: 1,
        color: '#3B82F6',
        statusOptions: [
            { value: 'interested', label: 'Interested', color: '#10B981', isDefault: true },
            { value: 'not_interested', label: 'Not Interested', color: '#EF4444' },
            { value: 'not_relevant', label: 'Not Relevant', color: '#9CA3AF' },
            { value: 'in_interview', label: 'In Interview', color: '#8B5CF6' }
        ],
        decisionOptions: [
            { value: 'shortlisted', label: 'Shortlisted', color: '#10B981', type: 'advance', nextPhaseOrder: 2 },
            { value: 'rejected', label: 'Rejected', color: '#EF4444', type: 'reject' },
            { value: 'on_hold', label: 'On Hold', color: '#F59E0B', type: 'hold' },
            { value: 'none', label: 'None / Not Decided', color: '#9CA3AF', type: 'hold' }
        ]
    },
    {
        name: 'Client Screening',
        description: 'Client review and decisioning.',
        order: 2,
        color: '#8B5CF6',
        statusOptions: [
            { value: 'submitted', label: 'Submitted', color: '#3B82F6', isDefault: true },
            { value: 'under_review', label: 'Under Review', color: '#8B5CF6' },
            { value: 'interview_scheduled', label: 'Interview Scheduled', color: '#06B6D4' }
        ],
        decisionOptions: [
            { value: 'selected', label: 'Selected', color: '#10B981', type: 'advance', nextPhaseOrder: 3 },
            { value: 'rejected', label: 'Rejected', color: '#EF4444', type: 'reject' },
            { value: 'on_hold', label: 'On Hold', color: '#F59E0B', type: 'hold' },
            { value: 'none', label: 'None / Not Decided', color: '#9CA3AF', type: 'hold' }
        ]
    },
    {
        name: 'Offer & Onboarding',
        description: 'Offer management and onboarding handoff.',
        order: 3,
        color: '#10B981',
        statusOptions: [
            { value: 'preparing_offer', label: 'Preparing Offer', color: '#3B82F6', isDefault: true },
            { value: 'offer_sent', label: 'Offer Sent', color: '#8B5CF6' },
            { value: 'offer_accepted', label: 'Offer Accepted', color: '#10B981' },
            { value: 'onboarding', label: 'Onboarding', color: '#059669' }
        ],
        decisionOptions: [
            { value: 'joined', label: 'Joined', color: '#059669', type: 'advance' },
            { value: 'offer_declined', label: 'Offer Declined', color: '#EF4444', type: 'reject' },
            { value: 'no_show', label: 'No Show', color: '#DC2626', type: 'reject' },
            { value: 'none', label: 'None / Not Decided', color: '#9CA3AF', type: 'hold' }
        ]
    }
]);

const run = async () => {
    await connectDB();

    const companies = await Company.find({}).select('_id name').lean();
    let createdCount = 0;

    for (const company of companies) {
        const existingCount = await PhaseTemplate.countDocuments({ companyId: company._id });
        if (existingCount > 0) {
            console.log(`Skipping ${company.name}: phase templates already exist.`);
            continue;
        }

        await PhaseTemplate.create({
            companyId: company._id,
            name: 'Standard Hiring Process',
            description: 'Default three-phase hiring workflow seeded for existing companies.',
            isDefault: true,
            isActive: true,
            phases: buildDefaultTemplatePhases()
        });

        createdCount += 1;
        console.log(`Seeded default phase template for ${company.name}`);
    }

    console.log(`Completed. Created ${createdCount} default phase template(s).`);
};

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('seed-default-phase-template error:', error);
        process.exit(1);
    });
