const OnboardingEmployee = require('../onboardingEmployee.model');
const { getCompanyEmailBranding } = require('./onboardingEmailController');
const { resolveNotificationEmailDelivery, syncTADecision } = require('../utils/onboardingHelpers');
const { sendEmailForCompany } = require('../../../services/companyEmailService');
const HREmailLog = require('../../email/hrEmailLog.model');
const archiver = require('archiver');
const axios = require('axios');

exports.toggleDocLivePhoto = async (req, res) => {
    try {
        const { id, docId } = req.params;
        const { requireLivePhoto } = req.body;

        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        doc.requireLivePhoto = Boolean(requireLivePhoto);

        employee.auditLog.push({
            action: 'LIVE_PHOTO_TOGGLE',
            details: `${doc.label} live photo requirement set to ${doc.requireLivePhoto}`
        });
        await employee.save();

        res.status(200).json({
            message: `Live photo requirement ${doc.requireLivePhoto ? 'enabled' : 'disabled'} for ${doc.label}`,
            document: doc,
            employee
        });
    } catch (error) {
        console.error('Error toggling live photo requirement:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.flagDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;
        const { reason } = req.body;

        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Not found' });

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        doc.status = 'Re-upload Required';
        doc.rejectionReason = reason || 'Please re-upload this document';

        if (employee.status === 'Submitted' || employee.status === 'Reviewed') {
            employee.status = 'In Progress';
            employee.submittedAt = null;
            if (employee.offerDeclaration) {
                employee.offerDeclaration.isComplete = false;
            }
        }

        employee.auditLog.push({ action: 'DOCUMENT_FLAGGED', details: `${doc.label} flagged: ${reason}` });
        await employee.save();

        const pendingReview = employee.documents.filter(d => d.status === 'Uploaded');
        if (pendingReview.length === 0) {
            const flaggedDocs = employee.documents.filter(d => d.status === 'Re-upload Required');
            if (flaggedDocs.length > 0) {
                const flaggedListHtml = flaggedDocs.map(fd => `
                    <div style="background: #fff5f5; border-left: 4px solid #f56565; padding: 12px; margin-bottom: 8px;">
                        <strong style="color: #c53030;">${fd.label}</strong><br/>
                        <span style="color: #718096; font-size: 13px;">Reason: ${fd.rejectionReason}</span>
                    </div>
                `).join('');

                const branding = await getCompanyEmailBranding(employee.companyId, req.company);
                const delivery = await resolveNotificationEmailDelivery(
                    employee.companyId,
                    'onboarding_document_reupload_required'
                );
                if (delivery.shouldSendEmail) {
                    const emailHtml = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                            <h2 style="color: #e53e3e;">Document Updates Required</h2>
                            <p>Hello ${employee.firstName},</p>
                            <p>During the review of your pre-onboarding submission, some documents were found to require updates or re-uploads:</p>
                            ${flaggedListHtml}
                            <p style="margin-top: 20px;">Please log in to your <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/pre-onboarding/login" style="color: #3182ce; font-weight: bold; text-decoration: none;">Pre-Onboarding Portal</a> to upload the corrected documents.</p>
                            <p>Once you've uploaded all the required items, please resubmit the form.</p>
                        </div>
                    `;
                    await sendEmailForCompany({
                        companyId: employee.companyId,
                        emailAccountId: delivery.emailAccountId,
                        to: employee.email,
                        subject: `Action Required: Document Updates Needed for Your Onboarding`,
                        html: emailHtml,
                        ...branding
                    });

                    await HREmailLog.create({
                        companyId: employee.companyId,
                        sentBy: req.user?._id,
                        recipientUserId: employee.transferredToUserId || null,
                        recipientEmail: employee.email,
                        subject: `Action Required: Document Updates Needed for Your Onboarding`,
                        body: emailHtml,
                        type: 'onboarding',
                        emailAccountId: delivery.emailAccountId || 'platform',
                        emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                        sentAt: new Date()
                    });
                }
            }
        }

        res.status(200).json({ message: 'Document flagged for re-upload', document: doc, employee });
    } catch (error) {
        console.error('Error flagging document:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.approveDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;

        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Not found' });

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        doc.status = 'Approved';
        doc.rejectionReason = '';

        const allReviewedStatus = employee.documents.every(d =>
            d.status === 'Approved' || d.status === 'Pending' || d.status === 'Mail Sent'
        );
        if (allReviewedStatus && employee.status === 'Submitted') {
            employee.status = 'Accepted';
        }

        employee.auditLog.push({ action: 'DOCUMENT_APPROVED', details: `${doc.label} approved` });
        await employee.save();

        const uploadedDocs = employee.documents.filter(d => d.url);
        const allApproved = uploadedDocs.length > 0 && uploadedDocs.every(d => d.status === 'Approved');
        if (allApproved) {
            await syncTADecision(employee, 'Joined');
        }

        const pendingReview = employee.documents.filter(d => d.status === 'Uploaded');
        if (pendingReview.length === 0) {
            const flaggedDocs = employee.documents.filter(d => d.status === 'Re-upload Required');
            if (flaggedDocs.length > 0) {
                const flaggedListHtml = flaggedDocs.map(fd => `
                    <div style="background: #fff5f5; border-left: 4px solid #f56565; padding: 12px; margin-bottom: 8px;">
                        <strong style="color: #c53030;">${fd.label}</strong><br/>
                        <span style="color: #718096; font-size: 13px;">Reason: ${fd.rejectionReason}</span>
                    </div>
                `).join('');

                const branding = await getCompanyEmailBranding(employee.companyId, req.company);
                const delivery = await resolveNotificationEmailDelivery(
                    employee.companyId,
                    'onboarding_document_reupload_required'
                );
                if (delivery.shouldSendEmail) {
                    const emailHtml = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                            <h2 style="color: #e53e3e;">Document Updates Required</h2>
                            <p>Hello ${employee.firstName},</p>
                            <p>During the review of your pre-onboarding submission, some documents were found to require updates or re-uploads:</p>
                            ${flaggedListHtml}
                            <p style="margin-top: 20px;">Please log in to your <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/pre-onboarding/login" style="color: #3182ce; font-weight: bold; text-decoration: none;">Pre-Onboarding Portal</a> to upload the corrected documents.</p>
                            <p>Once you've uploaded all the required items, please resubmit the form.</p>
                        </div>
                    `;
                    await sendEmailForCompany({
                        companyId: employee.companyId,
                        emailAccountId: delivery.emailAccountId,
                        to: employee.email,
                        subject: `Action Required: Document Updates Needed for Your Onboarding`,
                        html: emailHtml,
                        ...branding
                    });

                    await HREmailLog.create({
                        companyId: employee.companyId,
                        sentBy: req.user?._id,
                        recipientUserId: employee.transferredToUserId || null,
                        recipientEmail: employee.email,
                        subject: `Action Required: Document Updates Needed for Your Onboarding`,
                        body: emailHtml,
                        type: 'onboarding',
                        emailAccountId: delivery.emailAccountId || 'platform',
                        emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                        sentAt: new Date()
                    });
                }
            }
        }

        res.status(200).json({ message: 'Document approved', document: doc, employee });
    } catch (error) {
        console.error('Error approving document:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.downloadAllDocuments = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
        if (!employee) return res.status(404).json({ message: 'Not found' });

        const uploadedDocs = employee.documents.filter(d => d.url);
        if (uploadedDocs.length === 0) {
            return res.status(400).json({ message: 'No documents uploaded yet' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${employee.tempEmployeeId}_documents.zip`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const doc of uploadedDocs) {
            try {
                const response = await axios.get(doc.url, { responseType: 'stream' });
                const ext = doc.url.split('.').pop().split('?')[0] || 'pdf';
                archive.append(response.data, { name: `${doc.label.replace(/[^a-zA-Z0-9]/g, '_')}.${ext}` });
            } catch (downloadErr) {
                console.error(`Error downloading ${doc.label}:`, downloadErr.message);
            }
        }

        if (employee.bankDetails?.cancelledChequeUrl) {
            try {
                const response = await axios.get(employee.bankDetails.cancelledChequeUrl, { responseType: 'stream' });
                const ext = employee.bankDetails.cancelledChequeUrl.split('.').pop().split('?')[0] || 'pdf';
                archive.append(response.data, { name: `Cancelled_Cheque.${ext}` });
            } catch (e) { /* skip */ }
        }

        await archive.finalize();
    } catch (error) {
        console.error('Error generating ZIP:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
