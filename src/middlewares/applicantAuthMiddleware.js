const jwt = require('jsonwebtoken');
const Applicant = require('../models/Applicant');

exports.protectApplicant = async (req, res, next) => {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }

    try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.type !== 'applicant') {
            return res.status(401).json({ message: 'Invalid token type' });
        }

        req.applicant = await Applicant.findById(decoded.id)
            .select('firstName lastName email mobile isEmailVerified tokenVersion resumeUrl resumePublicId currentCTC expectedCTC noticePeriod')
            .lean();

        if (!req.applicant) {
            return res.status(401).json({ message: 'Applicant not found' });
        }

        const tokenVersion = decoded.tokenVersion || 0;
        if (tokenVersion !== (req.applicant.tokenVersion || 0)) {
            return res.status(401).json({ message: 'Session expired' });
        }

        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Not authorized' });
    }
};
