const Company = require('../models/Company');
const User = require('../models/User');
const { HiringRequest } = require('../models/HiringRequest');
const HelpdeskQuery = require('../models/HelpdeskQuery');

// GET /api/superadmin/analytics
const getGlobalAnalytics = async (req, res) => {
    try {
        const totalCompanies = await Company.countDocuments();
        const activeCompanies = await Company.countDocuments({ status: 'Active' });
        const totalEmployees = await User.countDocuments();
        const activeUsers = await User.countDocuments({ isActive: true });
        const totalHiring = await HiringRequest.countDocuments();
        const totalTickets = await HelpdeskQuery.countDocuments();

        // Company growth last 12 months
        const now = new Date();
        const companyGrowth = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const nextD = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
            const label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
            const count = await Company.countDocuments({ createdAt: { $gte: d, $lt: nextD } });
            companyGrowth.push({ month: label, companies: count });
        }

        // Employee count per company (top 10)
        const companiesList = await Company.find().select('name').limit(10);
        const employeesByCompany = await Promise.all(
            companiesList.map(async (c) => ({
                company: c.name,
                employees: await User.countDocuments({ companyId: c._id })
            }))
        );

        // Module usage
        const allCompanies = await Company.find().select('enabledModules');
        const moduleUsage = {};
        allCompanies.forEach(c => {
            (c.enabledModules || []).forEach(m => {
                moduleUsage[m] = (moduleUsage[m] || 0) + 1;
            });
        });
        const moduleUsageData = Object.entries(moduleUsage).map(([module, count]) => ({ module, count }));

        res.json({
            cards: { totalCompanies, activeCompanies, totalEmployees, activeUsers, totalHiring, totalTickets },
            companyGrowth,
            employeesByCompany,
            moduleUsageData,
        });
    } catch (err) {
        console.error('getGlobalAnalytics error:', err);
        res.status(500).json({ message: err.message });
    }
};

module.exports = { getGlobalAnalytics };
