const User = require('../../../modules/user/user.model');
const OnboardingEmployee = require('../../onboarding/onboardingEmployee.model');
const {
    ANNOUNCEMENT_CATEGORIES,
    AUDIENCE_TYPES,
    REACTION_TYPES,
    EMPLOYMENT_TYPES,
    setPrivateCache,
    normalizeStringArray,
    canManageAnnouncements,
    canViewAnnouncementCommunitySection,
    getBirthdayDateValue,
    getCurrentMonthDateValue,
    isSameRecurringMonth,
    isSameMonthDay,
    isSameCalendarMonth,
    getYearsCompleted,
    serializeCommunityMember
} = require('../utils/announcementHelpers');

exports.getAnnouncementComposerSetup = async (req, res) => {
    try {
        setPrivateCache(res, 60);
        const manageAccess = canManageAnnouncements(req.user);

        if (!manageAccess) {
            return res.json({
                canManage: false,
                categories: ANNOUNCEMENT_CATEGORIES,
                audienceTypes: AUDIENCE_TYPES,
                reactionTypes: REACTION_TYPES,
                departments: [],
                employmentTypes: EMPLOYMENT_TYPES,
                users: []
            });
        }

        const [departments, users] = await Promise.all([
            User.distinct('department', {
                companyId: req.companyId,
                isActive: true,
                department: { $nin: [null, ''] }
            }),
            User.find({ companyId: req.companyId, isActive: true })
                .select('firstName lastName email department employmentType profilePicture')
                .sort({ firstName: 1, lastName: 1 })
                .lean()
        ]);

        return res.json({
            canManage: true,
            categories: ANNOUNCEMENT_CATEGORIES,
            audienceTypes: AUDIENCE_TYPES,
            reactionTypes: REACTION_TYPES,
            departments: normalizeStringArray(departments).sort((left, right) => left.localeCompare(right)),
            employmentTypes: EMPLOYMENT_TYPES,
            users
        });
    } catch (error) {
        console.error('getAnnouncementComposerSetup error:', error);
        return res.status(500).json({ message: 'Failed to load announcement composer setup.' });
    }
};

exports.getAnnouncementBootstrap = exports.getAnnouncementComposerSetup;

exports.getAnnouncementCommunity = async (req, res) => {
    try {
        setPrivateCache(res, 300);
        const now = new Date();
        const sectionVisibility = {
            birthdays: canViewAnnouncementCommunitySection(req.user, 'birthdays'),
            anniversaries: canViewAnnouncementCommunitySection(req.user, 'anniversaries'),
            joinees: canViewAnnouncementCommunitySection(req.user, 'joinees')
        };

        const emptyResponse = {
            month: {
                year: now.getFullYear(),
                month: now.getMonth() + 1
            },
            visibility: sectionVisibility,
            birthdays: {
                currentMonth: [],
                today: [],
                count: 0
            },
            workAnniversaries: {
                currentMonth: [],
                today: [],
                count: 0
            },
            newJoinees: {
                currentMonth: [],
                count: 0
            }
        };

        if (!Object.values(sectionVisibility).some(Boolean)) {
            return res.json(emptyResponse);
        }

        const users = await User.find({ companyId: req.companyId, isActive: true })
            .select('firstName lastName email department employmentType profilePicture joiningDate employeeProfile createdAt')
            .populate('employeeProfile', 'personal.dob employment.joiningDate')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        const userIds = users.map((user) => user._id);
        const onboardingTransfers = await OnboardingEmployee.find({
            companyId: req.companyId,
            transferredToUserId: { $in: userIds }
        })
            .select('transferredToUserId personalDetails.dateOfBirth joiningDate')
            .lean();

        const onboardingTransferredUserIdSet = new Set(
            onboardingTransfers.map((entry) => String(entry.transferredToUserId || ''))
        );
        const onboardingEmployeeByUserId = new Map(
            onboardingTransfers.map((entry) => [String(entry.transferredToUserId || ''), entry])
        );

        const birthdayUsersCurrentMonth = sectionVisibility.birthdays
            ? users
                .filter((user) => isSameRecurringMonth(getBirthdayDateValue(user, onboardingEmployeeByUserId), now))
                .sort((left, right) => (
                    new Date(getBirthdayDateValue(left, onboardingEmployeeByUserId)).getDate()
                    - new Date(getBirthdayDateValue(right, onboardingEmployeeByUserId)).getDate()
                ))
            : [];

        const birthdaysCurrentMonth = sectionVisibility.birthdays
            ? birthdayUsersCurrentMonth.map((user) => serializeCommunityMember(user, {
                dateValue: getBirthdayDateValue(user, onboardingEmployeeByUserId),
                source: 'birthday'
            }))
            : [];

        const birthdaysToday = sectionVisibility.birthdays
            ? birthdayUsersCurrentMonth
                .filter((user) => isSameMonthDay(getBirthdayDateValue(user, onboardingEmployeeByUserId), now))
                .map((user) => serializeCommunityMember(user, {
                    dateValue: getBirthdayDateValue(user, onboardingEmployeeByUserId),
                    source: 'birthday'
                }))
            : [];

        const anniversaryUsersCurrentMonth = sectionVisibility.anniversaries
            ? users
                .filter((user) => {
                    const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                    return isSameRecurringMonth(joiningDate, now) && getYearsCompleted(joiningDate, now) > 0;
                })
                .sort((left, right) => {
                    const leftDate = getCurrentMonthDateValue(left, onboardingEmployeeByUserId);
                    const rightDate = getCurrentMonthDateValue(right, onboardingEmployeeByUserId);
                    return new Date(leftDate).getDate() - new Date(rightDate).getDate();
                })
            : [];

        const anniversariesCurrentMonth = sectionVisibility.anniversaries
            ? anniversaryUsersCurrentMonth.map((user) => {
                const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                return serializeCommunityMember(user, {
                    dateValue: joiningDate,
                    yearsCompleted: getYearsCompleted(joiningDate, now),
                    source: 'anniversary'
                });
            })
            : [];

        const anniversariesToday = sectionVisibility.anniversaries
            ? anniversaryUsersCurrentMonth
                .filter((user) => isSameMonthDay(getCurrentMonthDateValue(user, onboardingEmployeeByUserId), now))
                .map((user) => {
                    const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                    return serializeCommunityMember(user, {
                        dateValue: joiningDate,
                        yearsCompleted: getYearsCompleted(joiningDate, now),
                        source: 'anniversary'
                    });
                })
            : [];

        const newJoineesCurrentMonth = sectionVisibility.joinees
            ? users
                .filter((user) => {
                    const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                    return isSameCalendarMonth(joiningDate, now);
                })
                .sort((left, right) => (
                    new Date(getCurrentMonthDateValue(left, onboardingEmployeeByUserId))
                    - new Date(getCurrentMonthDateValue(right, onboardingEmployeeByUserId))
                ))
                .map((user) => serializeCommunityMember(user, {
                    dateValue: getCurrentMonthDateValue(user, onboardingEmployeeByUserId),
                    source: 'newJoinee',
                    transferredFromOnboarding: onboardingTransferredUserIdSet.has(String(user._id))
                }))
            : [];

        return res.json({
            month: {
                year: now.getFullYear(),
                month: now.getMonth() + 1
            },
            visibility: sectionVisibility,
            birthdays: {
                currentMonth: birthdaysCurrentMonth,
                today: birthdaysToday,
                count: birthdaysCurrentMonth.length
            },
            workAnniversaries: {
                currentMonth: anniversariesCurrentMonth,
                today: anniversariesToday,
                count: anniversariesCurrentMonth.length
            },
            newJoinees: {
                currentMonth: newJoineesCurrentMonth,
                count: newJoineesCurrentMonth.length
            }
        });
    } catch (error) {
        console.error('getAnnouncementCommunity error:', error);
        return res.status(500).json({ message: 'Failed to load announcement community data.' });
    }
};
