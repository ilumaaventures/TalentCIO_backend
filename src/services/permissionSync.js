const Permission = require('../models/Permission');
const permissionConfig = require('../config/permissions');

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

        // 4. Auto-assign ALL permissions in the database to the Admin role
        const allPermsInDb = await Permission.find({}).select('_id');
        const allDbPermissionIds = allPermsInDb.map(p => p._id);

        const Role = require('../models/Role');
        const adminRole = await Role.findOne({ $or: [{ name: 'Admin' }, { isSystem: true }] });

        if (adminRole) {
            // Add all permissions found in the database to the Admin role's array
            await Role.updateOne(
                { _id: adminRole._id },
                { $addToSet: { permissions: { $each: allDbPermissionIds } } }
            );
            console.log(`Updated Admin role by ensuring all ${allDbPermissionIds.length} DB permissions are assigned.`);
        } else {
            console.warn('System Admin role not found. Skipping auto-assignment.');
        }

        console.log('Permissions synced successfully.');
    } catch (error) {
        console.error('Error syncing permissions:', error);
    }
};

module.exports = syncPermissions;
