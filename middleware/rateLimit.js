const { rateLimit } = require('express-rate-limit');

const standardConfig = {
  standardHeaders: 'draft-7',
  legacyHeaders: false
};

const apiLimiter = rateLimit({
  ...standardConfig,
  windowMs: 15 * 60 * 1000,
  max: 1200,
  message: { error: 'Too many requests. Please slow down and try again shortly.' }
});

const bookingSubmitLimiter = rateLimit({
  ...standardConfig,
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: { error: 'Too many booking attempts from this network. Please try again in a few minutes.' }
});

const adminLoginLimiter = rateLimit({
  ...standardConfig,
  windowMs: 15 * 60 * 1000,
  max: 25,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please wait before trying again.' }
});

module.exports = {
  apiLimiter,
  bookingSubmitLimiter,
  adminLoginLimiter
};
