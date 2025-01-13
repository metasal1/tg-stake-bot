const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const fs = require('fs');
const dotenv = require('dotenv');
const TelegramBot = require('node-telegram-bot-api');

// Load environment variables
dotenv.config();

// Configuration
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const VALIDATOR_VOTE_ADDRESS = process.env.VALIDATOR_VOTE_ADDRESS;
const START_EPOCH = parseInt(process.env.START_EPOCH);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BROADCAST_CHANNEL = process.env.TELEGRAM_BROADCAST_CHANNEL; // Add this to your .env
const BROADCAST_INTERVAL = process.env.BROADCAST_INTERVAL || 3600000; // Default 1 hour in milliseconds

// Validate environment variables
if (!RPC_ENDPOINT) throw new Error('RPC_ENDPOINT is required in .env file');
if (!VALIDATOR_VOTE_ADDRESS) throw new Error('VALIDATOR_VOTE_ADDRESS is required in .env file');
if (isNaN(START_EPOCH)) throw new Error('START_EPOCH is required in .env file and must be a number');
if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required in .env file');
if (!TELEGRAM_BROADCAST_CHANNEL) throw new Error('TELEGRAM_BROADCAST_CHANNEL is required in .env file');

// Initialize Telegram bot with polling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connection = new Connection(RPC_ENDPOINT);

// Handle /id command
bot.onText(/\/id/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `Your Chat/Channel ID is: <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

// Handle /status command
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        await bot.sendMessage(chatId, 'Fetching current status...', { parse_mode: 'HTML' });
        await broadcastReport();
    } catch (error) {
        await bot.sendMessage(chatId, 'Error fetching status: ' + error.message);
    }
});

// Log bot startup
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

console.log('Bot started. Broadcasting to channel:', TELEGRAM_BROADCAST_CHANNEL);
console.log(`Broadcast interval: ${BROADCAST_INTERVAL / 1000} seconds`);

function calculateReward(stakeAmount) {
    if (stakeAmount <= 10000) {
        return 1;
    } else if (stakeAmount <= 50000) {
        return 0.95;
    } else {
        return 0.9;
    }
}

function calculateMultiplier(epochDifference) {
    if (epochDifference >= 15) {
        return 1.4;
    } else if (epochDifference >= 10) {
        return 1.2;
    } else if (epochDifference >= 6) {
        return 1.1;
    } else if (epochDifference >= 3) {
        return 1;
    } else {
        return 1;
    }
}

async function getStakeAccounts(pubkey) {
    try {
        const accounts = await connection.getParsedProgramAccounts(
            new PublicKey('Stake11111111111111111111111111111111111111'),
            {
                filters: [
                    {
                        memcmp: {
                            offset: 124,
                            bytes: pubkey
                        }
                    }
                ]
            }
        );

        return accounts.map(account => ({
            pubkey: account.pubkey.toString(),
            lamports: account.account.lamports,
            stake: account.account.lamports / LAMPORTS_PER_SOL
        }));
    } catch (error) {
        console.error('Error fetching stake accounts:', error);
        return [];
    }
}

async function broadcastToChannel(message) {
    try {
        await bot.sendMessage(TELEGRAM_BROADCAST_CHANNEL, message, {
            parse_mode: 'HTML',
            disable_notification: true  // Silent broadcast
        });
        console.log('Broadcast sent successfully');
    } catch (error) {
        console.error('Error broadcasting message:', error);
        throw error;
    }
}

async function sendFileToChannel(filePath, caption) {
    try {
        await bot.sendDocument(TELEGRAM_BROADCAST_CHANNEL, filePath, {
            caption: caption,
            parse_mode: 'HTML',
            disable_notification: true
        });
        console.log('File broadcast successfully');
    } catch (error) {
        console.error('Error broadcasting file:', error);
        throw error;
    }
}

async function getCurrentEpochAndStake() {
    try {
        const epochInfo = await connection.getEpochInfo();
        const currentEpoch = epochInfo.epoch;
        const epochDifference = currentEpoch - START_EPOCH;

        const stakeAccounts = await getStakeAccounts(VALIDATOR_VOTE_ADDRESS);
        const totalStake = stakeAccounts.reduce((acc, account) => acc + account.stake, 0);

        // Prepare data for CSV with reward calculations
        const data = stakeAccounts.map(account => {
            const stake = account.stake;
            const reward = calculateReward(stake);
            const multiplier = calculateMultiplier(epochDifference);
            const finalReward = reward * multiplier;

            return {
                stake_account: account.pubkey,
                stake_amount: stake,
                base_reward: reward,
                epoch_multiplier: multiplier,
                final_reward: finalReward
            };
        });

        // Save to CSV
        const filename = `${currentEpoch}.csv`;
        const csvContent = [
            'stake_account,stake_amount,base_reward,epoch_multiplier,final_reward',
            ...data.map(row =>
                `${row.stake_account},${row.stake_amount},${row.base_reward},${row.epoch_multiplier},${row.final_reward}`
            )
        ].join('\n');

        fs.writeFileSync(filename, csvContent);

        // Calculate totals for summary
        const totalBaseReward = data.reduce((acc, row) => acc + row.base_reward, 0) / data.length;
        const totalFinalReward = data.reduce((acc, row) => acc + row.final_reward, 0) / data.length;

        return {
            epoch: currentEpoch,
            epochDifference,
            totalStake,
            numberOfAccounts: stakeAccounts.length,
            averageBaseReward: totalBaseReward,
            averageFinalReward: totalFinalReward,
            filename
        };
    } catch (error) {
        console.error('Error in getCurrentEpochAndStake:', error);
        throw error;
    }
}

async function broadcastReport() {
    try {
        const result = await getCurrentEpochAndStake();

        // Prepare broadcast message
        const message = `
<b>🔄 Epoch ${result.epoch} Stake Report</b>

📊 <b>Statistics:</b>
• Epochs Since Start: ${result.epochDifference}
• Total Stake: ${result.totalStake.toFixed(2)} SOL
• Number of Accounts: ${result.numberOfAccounts}

🔍 <code>${VALIDATOR_VOTE_ADDRESS}</code>

⏰ ${new Date().toLocaleString()}`;

        // Broadcast message and file
        await broadcastToChannel(message);
        await sendFileToChannel(result.filename, `Epoch ${result.epoch} Stake Details`);

        // Cleanup local file
        fs.unlinkSync(result.filename);
        console.log('Broadcast completed and file cleaned up');

    } catch (error) {
        console.error('Error in broadcast:', error);
        const errorMessage = `❌ Error in stake analysis:\n${error.message}`;
        await broadcastToChannel(errorMessage);
    }
}

// Start periodic broadcasting
setInterval(broadcastReport, BROADCAST_INTERVAL);

// Initial broadcast
broadcastReport();

// Keep the script running
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});
