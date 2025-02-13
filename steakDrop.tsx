const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const fs = require('fs');
const dotenv = require('dotenv');
const TelegramBot = require('node-telegram-bot-api');

// Load environment variables
dotenv.config();

// Configuration
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const VALIDATOR_VOTE_ADDRESS = process.env.VALIDATOR_VOTE_ADDRESS;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BROADCAST_CHANNEL = process.env.TELEGRAM_BROADCAST_CHANNEL;
const EPOCH_CHECK_INTERVAL = 300000; // 5 minutes
const TOTAL_REWARD_POOL = 300_000_000;

// Validate environment variables
if (!RPC_ENDPOINT) throw new Error('RPC_ENDPOINT is required in .env file');
if (!VALIDATOR_VOTE_ADDRESS) throw new Error('VALIDATOR_VOTE_ADDRESS is required in .env file');
if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required in .env file');
if (!TELEGRAM_BROADCAST_CHANNEL) throw new Error('TELEGRAM_BROADCAST_CHANNEL is required in .env file');

// Initialize
const connection = new Connection(RPC_ENDPOINT);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let lastProcessedEpoch = null;
let lastHeartbeatDay = null;

function calculatePenaltyRate(stakeAmount) {
    if (stakeAmount <= 10000) return 0;
    if (stakeAmount <= 50000) return 5;
    return 10;
}

function calculateMultiplier(epochsStaked) {
    if (epochsStaked >= 15) return 1.4;
    if (epochsStaked >= 10) return 1.2;
    if (epochsStaked >= 6) return 1.1;
    if (epochsStaked >= 3) return 1;
    return 1;
}

async function getStakeAccounts(pubkey) {
    try {
        const currentEpoch = (await connection.getEpochInfo()).epoch;

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

        // Filter and map accounts
        const detailedAccounts = accounts
            .map(account => {
                const parsedData = account.account.data.parsed;
                const stake = account.account.lamports / LAMPORTS_PER_SOL;
                const stakeInfo = parsedData.info.stake;
                const meta = parsedData.info.meta;
                const activation = stakeInfo?.delegation?.activationEpoch;
                const deactivation = stakeInfo?.delegation?.deactivationEpoch;
                const epochsStaked = activation ? currentEpoch - Number(activation) : 0;
                const finalStake = stake * (1 - calculatePenaltyRate(stake) / 100) * calculateMultiplier(epochsStaked);

                return {
                    address: account.pubkey.toString(),
                    originalStake: stake,
                    penaltyRate: calculatePenaltyRate(stake),
                    penaltyAmount: (stake * calculatePenaltyRate(stake)) / 100,
                    epochsStaked,
                    multiplier: calculateMultiplier(epochsStaked),
                    finalStake,
                    stakeAuthority: meta.authorized.staker,
                    withdrawAuthority: meta.authorized.withdrawer,
                    status: deactivation === '18446744073709551615' ? 'Active' : 'Inactive',
                    activationStatus: activation ? 'Activated' : 'Pending',
                    activationEpoch: activation || null,
                    deactivationEpoch: deactivation === '18446744073709551615' ? null : deactivation
                };
            })
            // Filter out inactive accounts
            .filter(account => account.status === 'Active' && account.activationStatus === 'Activated');

        // Calculate total final stake for reward distribution using only active accounts
        const totalFinalStake = detailedAccounts.reduce((acc, account) => acc + account.finalStake, 0);

        // Add reward calculations
        return detailedAccounts.map(account => ({
            ...account,
            rewardShare: (account.finalStake / totalFinalStake) * 100,
            rewardAmount: (account.finalStake / totalFinalStake) * TOTAL_REWARD_POOL
        }));
    } catch (error) {
        console.error('Error getting stake accounts:', error);
        throw error;
    }
}

async function sendTelegramMessage(message) {
    try {
        await bot.sendMessage(TELEGRAM_BROADCAST_CHANNEL, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (error) {
        console.error('Error sending Telegram message:', error);
        throw error;
    }
}

async function sendTelegramFile(filePath, caption) {
    try {
        await bot.sendDocument(TELEGRAM_BROADCAST_CHANNEL, filePath, {
            caption: caption,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error('Error sending file to Telegram:', error);
        throw error;
    }
}

async function generateAndSendReport(epoch) {
    try {
        const stakeAccounts = await getStakeAccounts(VALIDATOR_VOTE_ADDRESS);
        const totalStake = stakeAccounts.reduce((acc, account) => acc + account.originalStake, 0);

        // Save to CSV
        const filename = `${epoch}.csv`;
        const csvContent = [
            'Address,Original Stake (SOL),Penalty Rate (%),Penalty Amount (SOL),Epochs Staked,Multiplier,Final Stake (SOL),Reward Share (%),Reward Amount (Tokens),Stake Authority,Withdraw Authority,Status,Activation Status,Activation Epoch,Deactivation Epoch',
            ...stakeAccounts.map(account =>
                [
                    account.address,
                    account.originalStake.toFixed(2),
                    account.penaltyRate,
                    account.penaltyAmount.toFixed(2),
                    account.epochsStaked,
                    account.multiplier,
                    account.finalStake.toFixed(2),
                    account.rewardShare.toFixed(4),
                    account.rewardAmount.toFixed(2),
                    account.stakeAuthority,
                    account.withdrawAuthority,
                    account.status,
                    account.activationStatus,
                    account.activationEpoch,
                    account.deactivationEpoch
                ].join(',')
            )
        ].join('\n');

        fs.writeFileSync(filename, csvContent);

        // Modified Telegram message
        const message = `
<b>🔄 Epoch ${epoch} Stake Report</b>

📊 <b>Statistics:</b>
• Total Stake: ${totalStake.toFixed(2)} SOL
• Number of Accounts: ${stakeAccounts.length}
• Total Reward Pool: ${TOTAL_REWARD_POOL.toLocaleString()} Tokens

🔍 <code>${VALIDATOR_VOTE_ADDRESS}</code>

⏰ ${new Date().toLocaleString()}`;

        await sendTelegramMessage(message);
        await sendTelegramFile(filename, `Epoch ${epoch} Stake Details`);

        // Cleanup
        fs.unlinkSync(filename);
        console.log(`Completed report for epoch ${epoch}`);

    } catch (error) {
        console.error('Error generating report:', error);
        await sendTelegramMessage(`❌ Error generating report for epoch ${epoch}:\n${error.message}`);
    }
}

async function sendHeartbeat() {
    const now = new Date();
    const currentDay = now.toISOString().split('T')[0];

    if (lastHeartbeatDay !== currentDay) {
        try {
            const epochInfo = await connection.getEpochInfo();
            const slotsRemaining = epochInfo.slotsInEpoch - epochInfo.slotIndex;
            const estimatedMinutesRemaining = Math.floor((slotsRemaining * 0.4) / 60);

            const message = `
<b>💗 Daily Heartbeat</b>

Bot is running and monitoring:
• Current Time: ${now.toLocaleString()}
• Validator: <code>${VALIDATOR_VOTE_ADDRESS}</code>
• Current Epoch: ${epochInfo.epoch}
• ETA Next Epoch: ~${estimatedMinutesRemaining} minutes
• Slots Remaining: ${slotsRemaining.toLocaleString()}

Next epoch report will be sent automatically when epoch ${epochInfo.epoch + 1} starts.`;

            await sendTelegramMessage(message);
            lastHeartbeatDay = currentDay;
            console.log('Daily heartbeat sent:', currentDay);
        } catch (error) {
            console.error('Error sending heartbeat:', error);
            throw error;
        }
    }
}

async function checkEpochAndSendReport() {
    try {
        const epochInfo = await connection.getEpochInfo();
        const currentEpoch = epochInfo.epoch;

        // First run initialization
        if (lastProcessedEpoch === null) {
            lastProcessedEpoch = currentEpoch;
            console.log(`Initial epoch: ${currentEpoch}`);
            return;
        }

        // If epoch has increased, generate and send report for the previous epoch
        if (currentEpoch > lastProcessedEpoch) {
            console.log(`Epoch increased from ${lastProcessedEpoch} to ${currentEpoch}`);
            await generateAndSendReport(lastProcessedEpoch);
            lastProcessedEpoch = currentEpoch;
        } else {
            // Log progress without sending message
            const slotsRemaining = epochInfo.slotsInEpoch - epochInfo.slotIndex;
            const estimatedMinutesRemaining = Math.floor((slotsRemaining * 0.4) / 60);
            console.log(`Current epoch: ${currentEpoch}, Slots remaining: ${slotsRemaining}, Est. time remaining: ${estimatedMinutesRemaining} minutes`);
        }
    } catch (error) {
        console.error('Error checking epoch:', error);
    }
}

function setupTimers() {
    // Check epoch every 5 minutes
    setInterval(checkEpochAndSendReport, EPOCH_CHECK_INTERVAL);

    // Check for daily heartbeat every hour
    setInterval(sendHeartbeat, 3600000);

    // Initial checks
    checkEpochAndSendReport();
    sendHeartbeat();
}

// Setup and error handling
async function main() {
    try {
        console.log('Starting monitoring system...');
        console.log('• Daily heartbeat enabled');
        console.log(`• Checking epoch every ${EPOCH_CHECK_INTERVAL / 1000} seconds`);
        console.log('• Reports will be sent on epoch change');

        setupTimers();

        // Handle /id command
        bot.onText(/\/id/, (msg) => {
            const chatId = msg.chat.id;
            bot.sendMessage(chatId, `Your Chat/Channel ID is: <code>${chatId}</code>`, { parse_mode: 'HTML' });
        });

        // Handle /status command
        bot.onText(/\/status/, async (msg) => {
            try {
                const epochInfo = await connection.getEpochInfo();
                const slotsRemaining = epochInfo.slotsInEpoch - epochInfo.slotIndex;
                const estimatedMinutesRemaining = Math.floor((slotsRemaining * 0.4) / 60);

                const statusMessage = `
<b>📊 Current Status</b>

• Current Epoch: ${epochInfo.epoch}
• Slots Remaining: ${slotsRemaining}
• Est. Time Remaining: ${estimatedMinutesRemaining} minutes
• Last Processed Epoch: ${lastProcessedEpoch}
• Bot Running Since: ${new Date(process.uptime() * 1000).toLocaleString()}

Next report will be sent when epoch ${epochInfo.epoch + 1} starts.`;

                await bot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'HTML' });
            } catch (error) {
                await bot.sendMessage(msg.chat.id, 'Error fetching status: ' + error.message);
            }
        });

    } catch (error) {
        console.error('Error in main:', error);
        process.exit(1);
    }
}

// Start the system
main();

// Handle errors
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});
