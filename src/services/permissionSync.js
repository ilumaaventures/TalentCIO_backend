const Permission = require('../models/Permission');
const permissionConfig = require('../config/permissions');
const { assignPermissionsToAdminRoles } = require('./adminPermissionAssignment');

const LEGACY_PERMISSION_REPLACEMENTS = {
    'ta.application.read': 'ta.candidate.view',
    'ta.application.create': 'ta.candidate.manage.assigned',
    'ta.application.update': 'ta.candidate.manage.assigned',
    'ta.application.delete': 'ta.candidate.manage.assigned',
    'ta.application.manage.assigned': 'ta.candidate.manage.assigned',
    'ta.application.manage.all': 'ta.candidate.manage.all',
    'ta.candidate.view.client_name': 'ta.requisition.view.client_name',
    'ta.client.confidential.view': 'ta.requisition.view.client_name',
    'ta.candidate.view.pii': 'ta.candidate.sensitive.view',
    'ta.candidate.resume.download': 'ta.resume.download',
    'ta.candidate.evaluate_round': 'ta.interview.evaluate',
    'ta.config.manage': 'ta.config.edit',
    'ta.offer.create': 'ta.candidate.make_decision',
    'ta.offer.view': 'ta.candidate.make_decision',
    'ta.offer.approve': 'ta.candidate.make_decision',
    'ta.offer.revoke': 'ta.candidate.make_decision'
};

const LEGACY_REMOVED_PERMISSION_KEYS = [
    'ta.analytics.requisition',
    'ta.interview.schedule',
    ...Object.keys(LEGACY_PERMISSION_REPLACEMENTS)
];

const syncPermissions = async () => {
    try {
        console.log('Syncing permissions...');

        // 1. Get all config permissions keys
        const configKeys = permissionConfig.map(p => p.key);

        const allPermissionIds = [];

        // 2. Upsert (Insert or Update) permissions from config
        for (const perm of permissionConfig) {
            const savedPerm = await Permission.findOneAndUpdate(
                { key: perm.key },
                {
                    module: perm.module,
                    description: perm.description,
                    isDeprecated: false
                },
                { upsert: true, new: true }
            );
            allPermissionIds.push(savedPerm._id);
        }

        // 3. We will NOT mark permissions not in config as deprecated, 
        // to preserve any custom permissions added via UI, Compass, or other scripts.

        const Role = require('../models/Role');
        const legacyPermissions = await Permission.find({
            key: { $in: LEGACY_REMOVED_PERMISSION_KEYS }
        }).select('_id key');

        if (legacyPermissions.length > 0) {
            const legacyPermissionIds = legacyPermissions.map(permission => permission._id);
            const legacyPermissionIdSet = new Set(legacyPermissionIds.map((permissionId) => String(permissionId)));
            const replacementKeys = Array.from(new Set(
                legacyPermissions
                    .map((permission) => LEGACY_PERMISSION_REPLACEMENTS[permission.key])
                    .filter(Boolean)
            ));
            const replacementPermissions = replacementKeys.length > 0
                ? await Permission.find({ key: { $in: replacementKeys } }).select('_id key')
                : [];
            const replacementIdByKey = replacementPermissions.reduce((accumulator, permission) => {
                accumulator[permission.key] = permission._id;
                return accumulator;
            }, {});

            const rolesNeedingMigration = await Role.find({
                permissions: { $in: legacyPermissionIds }
            }).select('_id permissions');

            for (const role of rolesNeedingMigration) {
                const currentPermissions = Array.isArray(role.permissions) ? role.permissions : [];
                const currentPermissionIdSet = new Set(currentPermissions.map((permissionId) => String(permissionId)));
                const finalPermissionIds = [];
                const finalPermissionIdSet = new Set();

                currentPermissions.forEach((permissionId) => {
                    const permissionIdString = String(permissionId);
                    if (legacyPermissionIdSet.has(permissionIdString) || finalPermissionIdSet.has(permissionIdString)) {
                        return;
                    }

                    finalPermissionIdSet.add(permissionIdString);
                    finalPermissionIds.push(permissionId);
                });

                legacyPermissions.forEach((legacyPermission) => {
                    if (!currentPermissionIdSet.has(String(legacyPermission._id))) {
                        return;
                    }

                    const replacementKey = LEGACY_PERMISSION_REPLACEMENTS[legacyPermission.key];
                    const replacementId = replacementKey ? replacementIdByKey[replacementKey] : null;
                    const replacementIdString = replacementId ? String(replacementId) : null;
                    if (replacementIdString && !finalPermissionIdSet.has(replacementIdString)) {
                        finalPermissionIdSet.add(replacementIdString);
                        finalPermissionIds.push(replacementId);
                    }
                });

                await Role.updateOne(
                    { _id: role._id },
                    { $set: { permissions: finalPermissionIds } }
                );
            }

            await Permission.updateMany(
                { _id: { $in: legacyPermissionIds } },
                { $set: { isDeprecated: true } }
            );

            console.log(`Deprecated and detached legacy permissions: ${legacyPermissions.map(permission => permission.key).join(', ')}`);
        }

        // 4. Auto-assign ALL permissions in the database to the Admin role
        const allPermsInDb = await Permission.find({}).select('_id');
        const allDbPermissionIds = allPermsInDb.map(p => p._id);

        const adminPermissionAssignment = await assignPermissionsToAdminRoles(allDbPermissionIds);
        if (adminPermissionAssignment.matchedCount > 0) {
            console.log(`Updated admin roles by ensuring all ${allDbPermissionIds.length} DB permissions are assigned.`);
        } else {
            console.warn('No admin roles found. Skipping auto-assignment.');
        }

        const hrAdminRole = await Role.findOne({ name: 'HR Admin' }).select('_id permissions');
        if (hrAdminRole) {
            const settingsPermissions = await Permission.find({
                key: {
                    $in: [
                        'settings.email.view',
                        'settings.email.manage',
                        'settings.notification.view',
                        'settings.notification.manage'
                    ]
                }
            }).select('_id');

            if (settingsPermissions.length > 0) {
                await Role.updateOne(
                    { _id: hrAdminRole._id },
                    { $addToSet: { permissions: { $each: settingsPermissions.map((permission) => permission._id) } } }
                );
                console.log('Updated HR Admin role with settings permissions.');
            }
        }

        console.log('Permissions synced successfully.');
    } catch (error) {
        console.error('Error syncing permissions:', error);
    }
};

module.exports = syncPermissions;
