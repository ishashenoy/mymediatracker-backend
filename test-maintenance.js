// Simple test to verify maintenance mode functionality
const maintenanceMode = require('./middleware/maintenanceMode');

// Mock request and response objects
const mockReq = {};
const mockRes = {
  status: (code) => ({
    json: (data) => {
      console.log(`Status: ${code}`);
      console.log('Response:', JSON.stringify(data, null, 2));
      return mockRes;
    }
  })
};

// Test with maintenance mode enabled
console.log('=== Testing with MAINTENANCE_MODE=true ===');
process.env.MAINTENANCE_MODE = 'true';

const next1 = () => console.log('Next() called - should NOT happen in maintenance mode');
maintenanceMode(mockReq, mockRes, next1);

console.log('\n=== Testing with MAINTENANCE_MODE=false ===');
process.env.MAINTENANCE_MODE = 'false';

const next2 = () => console.log('Next() called - should happen when maintenance mode is disabled');
maintenanceMode(mockReq, mockRes, next2);

console.log('\n=== Testing with MAINTENANCE_MODE undefined ===');
delete process.env.MAINTENANCE_MODE;

const next3 = () => console.log('Next() called - should happen when maintenance mode is not set');
maintenanceMode(mockReq, mockRes, next3);
