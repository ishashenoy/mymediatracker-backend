// Maintenance mode middleware
// Blocks media creation endpoints when maintenance mode is enabled

const maintenanceMode = (req, res, next) => {
  // Check if maintenance mode is enabled
  if (process.env.MAINTENANCE_MODE === 'true') {
    return res.status(503).json({ 
      error: "Media list editing is temporarily disabled for maintenance" 
    });
  }
  
  // If maintenance mode is disabled, proceed to the next middleware
  next();
};

module.exports = maintenanceMode;
