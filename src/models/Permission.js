const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true
    },
    module: {
        type: String,
        required: true
    },
    description: String,
    isSystem: {
        type: Boolean,
        default: false
    },
    isDeprecated: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Auto-assign newly created permissions to Admin
permissionSchema.post('save', async function (doc, next) {
    try {
        const Role = mongoose.model('Role');
        // Find all roles that are either named 'Admin' or marked as system roles
        // We push the new permission ID to their permissions array
        await Role.updateMany(
            { $or: [{ name: 'Admin' }, { isSystem: true }] },
            { $addToSet: { permissions: doc._id } }
        );
        next();
    } catch (error) {
        console.error('Error auto-assigning permission to Admin:', error);
        next(error);
    }
});

module.exports = mongoose.model('Permission', permissionSchema);
