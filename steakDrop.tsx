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
const TELEGRAM_BROADCAST_CHANNEL = process.env.TELEGRAM_BROADCAST_CHANNEL;
const BROADCAST_INTERVAL = process.env.BROADCAST_INTERVAL || 3600000;

// Validate environment variables
if (!RPC_ENDPOINT) throw new Error('RPC_ENDPOINT is required in .env file');
if (!VALIDATOR_VOTE_ADDRESS) throw new Error('VALIDATOR_VOTE_ADDRESS is required in .env file');
if (isNaN(START_EPOCH)) throw new Error('START_EPOCH is required in .env file and must be a number');
if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required in .env file');
if (!TELEGRAM_BROADCAST_CHANNEL) throw new Error('TELEGRAM_BROADCAST_CHANNEL is required in .env file');

const connection = new Connection(RPC_ENDPOINT);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function calculatePenaltyRate(stakeAmount) {
    if (stakeAmount <= 10000) {
        return 0;  // 1 - 1 = 0% penalty
    } else if (stakeAmount <= 50000) {
        return 5;  // 1 - 0.95 = 5% penalty
    } else {
        return 10; // 1 - 0.9 = 10% penalty
    }
}

function calculateMultiplier(epochsStaked) {
    if (epochsStaked >= 15) {
        return 1.4;
    } else if (epochsStaked >= 10) {
        return 1.2;
    } else if (epochsStaked >= 6) {
        return 1.1;
    } else if (epochsStaked >= 3) {
        return 1;
    } else {
        return 1;
    }
}

async function getStakeAccountInfo(pubkey) {
    try {
        const stakeAccount = await connection.getParsedAccountInfo(new PublicKey(pubkey));
        if (!stakeAccount.value || !stakeAccount.value.data || !stakeAccount.value.data.parsed) {
            return null;
        }
        return stakeAccount.value.data.parsed;
    } catch (error) {
        console.error(`Error fetching stake account info for ${pubkey}:`, error);
        return null;
    }
}

const TOTAL_REWARD_POOL = 300_000_000; // 300M tokens

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

        // First pass to calculate total final stake for reward distribution
        const detailedAccounts = accounts.map((account, index) => {
            const parsedData = account.account.data.parsed;
            const stake = account.account.lamports / LAMPORTS_PER_SOL;
            const stakeInfo = parsedData.info.stake;
            const meta = parsedData.info.meta;
            const activation = stakeInfo?.delegation?.activationEpoch;
            const deactivation = stakeInfo?.delegation?.deactivationEpoch;
            const epochsStaked = activation ? currentEpoch - Number(activation) : 0;
            const finalStake = stake * (1 - calculatePenaltyRate(stake) / 100) * calculateMultiplier(epochsStaked);

            return {
                rank: index + 1,
                address: account.pubkey.toString(),
                originalStake: stake,
                penaltyRate: calculatePenaltyRate(stake),
                penaltyAmount: (stake * calculatePenaltyRate(stake)) / 100,
                epochsStaked,
                multiplier: calculateMultiplier(epochsStaked),
                finalStake,
                stakeAuthority: meta.authorized.staker,
                withdrawAuthority: meta.authorized.withdrawer,
                status: Number(deactivation) === 18446744073709552000n ? 'Active' : 'Inactive',
                activationStatus: stakeInfo?.delegation?.activationEpoch ? 'Activated' : 'Pending',
                activationEpoch: activation || 'N/A',
                deactivationEpoch: deactivation === '18446744073709551615' ? null : deactivation
            };
        });

        // Calculate total final stake for reward distribution
        const totalFinalStake = detailedAccounts.reduce((acc, account) => acc + account.finalStake, 0);

        // Second pass to add reward calculations
        return detailedAccounts.map(account => ({
            ...account,
            rewardShare: (account.finalStake / totalFinalStake) * 100,
            rewardAmount: (account.finalStake / totalFinalStake) * TOTAL_REWARD_POOL
        }));

        return detailedAccounts;
    } catch (error) {
        console.error('Error fetching stake accounts:', error);
        return [];
    }
}

async function getCurrentEpochAndStake() {
    try {
        const epochInfo = await connection.getEpochInfo();
        const targetEpoch = epochInfo.epoch - 1;
        const epochDifference = targetEpoch - START_EPOCH;

        const stakeAccounts = await getStakeAccounts(VALIDATOR_VOTE_ADDRESS);
        const totalStake = stakeAccounts.reduce((acc, account) => acc + account.originalStake, 0);

        // Save to CSV
        const filename = `${targetEpoch}.csv`;
        const csvContent = [
            'Rank,Address,Original Stake (SOL),Penalty Rate (%),Penalty Amount (SOL),Epochs Staked,Multiplier,Final Stake (SOL),Reward Share (%),Reward Amount (Tokens),Stake Authority,Withdraw Authority,Status,Activation Status,Activation Epoch,Deactivation Epoch',
            ...stakeAccounts.map(account =>
                [
                    account.rank,
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

        return {
            epoch: targetEpoch,
            epochDifference,
            totalOriginalStake: totalStake,
            totalFinalStake: stakeAccounts.reduce((acc, account) => acc + account.finalStake, 0),
            numberOfAccounts: stakeAccounts.length,
            filename
        };
    } catch (error) {
        console.error('Error in getCurrentEpochAndStake:', error);
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

async function broadcastReport() {
    try {
        const result = await getCurrentEpochAndStake();

        const message = `
<b>🔄 Epoch ${result.epoch} Stake Report</b>

📊 <b>Statistics:</b>
• Total Original Stake: ${result.totalOriginalStake.toFixed(2)} SOL
• Total Final Stake: ${result.totalFinalStake.toFixed(2)} SOL
• Number of Accounts: ${result.numberOfAccounts}
• Epochs Since Start: ${result.epochDifference}
• Total Reward Pool: ${TOTAL_REWARD_POOL.toLocaleString()} Tokens

🔍 <code>${VALIDATOR_VOTE_ADDRESS}</code>

⏰ ${new Date().toLocaleString()}`;

        await sendTelegramMessage(message);
        await sendTelegramFile(result.filename, `Epoch ${result.epoch} Stake Details`);

        fs.unlinkSync(result.filename);
        console.log('Broadcast completed and file cleaned up');

    } catch (error) {
        console.error('Error in broadcast:', error);
        const errorMessage = `❌ Error in stake analysis:\n${error.message}`;
        await sendTelegramMessage(errorMessage);
    }
}

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

// Start periodic broadcasting
setInterval(broadcastReport, BROADCAST_INTERVAL);

// Initial broadcast
broadcastReport();

// Keep the script running
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});
