const mongoose = require('mongoose');

module.exports = function softDeletePlugin(schema) {
    if (!schema.path('isDeleted')) {
        schema.add({
            isDeleted: { type: Boolean, default: false, index: true },
            deletedAt: { type: Date, default: null },
            deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
        });
    }

    const applyDeletedFilter = (query) => {
        if (query.getOptions?.().includeDeleted) {
            return;
        }

        const conditions = query.getFilter ? query.getFilter() : query._conditions || {};
        if (conditions.isDeleted === undefined) {
            query.where({ isDeleted: { $ne: true } });
        }
    };

    schema.pre(/^find/, function softDeleteFindMiddleware() {
        applyDeletedFilter(this);
    });

    schema.pre('countDocuments', function softDeleteCountDocumentsMiddleware() {
        applyDeletedFilter(this);
    });

    schema.pre('count', function softDeleteCountMiddleware() {
        applyDeletedFilter(this);
    });

    schema.pre('aggregate', function softDeleteAggregateMiddleware() {
        if (this.options?.includeDeleted) {
            return;
        }

        const pipeline = this.pipeline();
        const alreadyScoped = pipeline.some((stage) => stage.$match && stage.$match.isDeleted !== undefined);
        if (alreadyScoped) {
            return;
        }

        const deletedMatchStage = { $match: { isDeleted: { $ne: true } } };
        const firstStageOperator = Object.keys(pipeline[0] || {})[0];
        const mustStayFirst = ['$geoNear', '$search', '$vectorSearch'].includes(firstStageOperator);

        if (mustStayFirst) {
            pipeline.splice(1, 0, deletedMatchStage);
        } else {
            pipeline.unshift(deletedMatchStage);
        }
    });

    schema.methods.softDelete = async function softDelete(userId) {
        this.isDeleted = true;
        this.deletedAt = new Date();
        this.deletedBy = userId || null;
        return this.save();
    };

    schema.methods.restore = async function restore() {
        this.isDeleted = false;
        this.deletedAt = null;
        this.deletedBy = null;
        return this.save();
    };
};
