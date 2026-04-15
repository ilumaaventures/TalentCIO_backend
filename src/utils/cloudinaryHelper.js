/**
 * Extracts the Cloudinary public ID from a given URL.
 * Handles standard Cloudinary URLs including those with version numbers.
 * 
 * Example:
 * Input: https://res.cloudinary.com/demo/image/upload/v1570979139/folder/sample.jpg
 * Output: folder/sample
 * 
 * @param {string} url - The complete Cloudinary image URL
 * @returns {string|null} - The public ID or null if extraction fails
 */
const extractPublicIdFromUrl = (url) => {
    try {
        if (!url) return null;

        // Find the index of '/upload/'
        const uploadIndex = url.indexOf('/upload/');
        if (uploadIndex === -1) return null;

        // Get the string after /upload/
        let publicId = url.substring(uploadIndex + 8);

        // Remove the version string if present (e.g., v1234567890/)
        publicId = publicId.replace(/^v\d+\//, '');

        // Remove the file extension if present (e.g., .jpg, .pdf)
        const dotIndex = publicId.lastIndexOf('.');
        if (dotIndex !== -1) {
            publicId = publicId.substring(0, dotIndex);
        }

        return publicId;

    } catch (error) {
        console.error('Error extracting public ID from URL:', error);
        return null;
    }
};

module.exports = { extractPublicIdFromUrl };
