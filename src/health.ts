import express from 'express';
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'cubapoker-telegram-bot',
    timestamp: new Date().toISOString(),
  });
});

export default router;
