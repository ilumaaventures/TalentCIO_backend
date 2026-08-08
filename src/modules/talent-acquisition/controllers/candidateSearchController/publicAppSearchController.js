const { HiringRequest } = require('../../hiringRequest.model');
const PublicApplication = require('../../publicApplication.model');
const { attachLastApplicationData } = require('../../utils/applicationHistoryUtils');

exports.globalSearchPublicApplications = async (req, res) => {
    try {
        const filterQuery = { companyId: req.companyId };

        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            filterQuery.$or = [
                { candidateName: searchRegex },
                { email: searchRegex },
                { mobile: searchRegex },
                { coverNote: searchRegex },
                { reviewNote: searchRegex }
            ];
        }

        if (req.query.reviewStatus && req.query.reviewStatus !== '') {
            filterQuery.reviewStatus = req.query.reviewStatus.trim();
        }

        if (req.query.maxNoticePeriod !== undefined && req.query.maxNoticePeriod !== '') {
            const noticeVal = Number(req.query.maxNoticePeriod);
            if (Number.isFinite(noticeVal)) {
                filterQuery.noticePeriod = { $lte: noticeVal };
            }
        }

        if (req.query.minCurrentCTC !== undefined || req.query.maxCurrentCTC !== undefined) {
            filterQuery.currentCTC = {};
            if (req.query.minCurrentCTC !== undefined && req.query.minCurrentCTC !== '') {
                const minCTC = Number(req.query.minCurrentCTC);
                if (Number.isFinite(minCTC)) filterQuery.currentCTC.$gte = minCTC;
            }
            if (req.query.maxCurrentCTC !== undefined && req.query.maxCurrentCTC !== '') {
                const maxCTC = Number(req.query.maxCurrentCTC);
                if (Number.isFinite(maxCTC)) filterQuery.currentCTC.$lte = maxCTC;
            }
            if (Object.keys(filterQuery.currentCTC).length === 0) delete filterQuery.currentCTC;
        }

        if (req.query.minExpectedCTC !== undefined || req.query.maxExpectedCTC !== undefined) {
            filterQuery.expectedCTC = {};
            if (req.query.minExpectedCTC !== undefined && req.query.minExpectedCTC !== '') {
                const minCTC = Number(req.query.minExpectedCTC);
                if (Number.isFinite(minCTC)) filterQuery.expectedCTC.$gte = minCTC;
            }
            if (req.query.maxExpectedCTC !== undefined && req.query.maxExpectedCTC !== '') {
                const maxCTC = Number(req.query.maxExpectedCTC);
                if (Number.isFinite(maxCTC)) filterQuery.expectedCTC.$lte = maxCTC;
            }
            if (Object.keys(filterQuery.expectedCTC).length === 0) delete filterQuery.expectedCTC;
        }

        if (req.query.client) {
            const clientHiringRequests = await HiringRequest.find({
                companyId: req.companyId,
                client: new RegExp(req.query.client.trim(), 'i')
            }).select('_id').lean();
            filterQuery.hiringRequestId = { $in: clientHiringRequests.map(hr => hr._id) };
        }

        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.max(Number(req.query.limit) || 15, 1);
        const skip = (page - 1) * limit;

        const [total, applications] = await Promise.all([
            PublicApplication.countDocuments(filterQuery),
            PublicApplication.find(filterQuery)
                .populate('applicantId', 'firstName lastName email mobile currentCity currentState')
                .populate('hiringRequestId', 'requestId roleDetails client clientConfidential')
                .populate('reviewedBy', 'firstName lastName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        let filteredApps = applications;

        if (req.query.minExperience !== undefined && req.query.minExperience !== '' ||
            req.query.maxExperience !== undefined && req.query.maxExperience !== '') {
            const minExp = req.query.minExperience !== '' ? Number(req.query.minExperience) : null;
            const maxExp = req.query.maxExperience !== '' ? Number(req.query.maxExperience) : null;
            filteredApps = filteredApps.filter(app => {
                const expYears = app.profileSnapshot?.totalExperience ?? app.profileSnapshot?.experienceYears ?? null;
                if (expYears === null || expYears === undefined) return true;
                if (minExp !== null && Number.isFinite(minExp) && expYears < minExp) return false;
                if (maxExp !== null && Number.isFinite(maxExp) && expYears > maxExp) return false;
                return true;
            });
        }

        const applicationsWithHistory = await attachLastApplicationData(filteredApps);

        res.status(200).json({
            currentPage: page,
            totalPages: Math.max(Math.ceil(total / limit), 1),
            count: total,
            limit,
            applications: applicationsWithHistory
        });
    } catch (error) {
        console.error('Error in global search public applications:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
