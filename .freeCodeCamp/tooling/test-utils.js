import { readFile, readdir } from 'fs/promises';
import { exec, execSync } from 'child_process';
import sha256 from 'crypto-js/sha256.js';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import elliptic from 'elliptic';
import { join, dirname } from 'path';
import fs from 'fs';
import WebSocket, { WebSocketServer } from 'ws';

const execute = promisify(exec);
const ec = new elliptic.ec('p192');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '../..');

async function getDirectory(path) {
  const files = await readdir(`${ROOT}/${path}`);
  return files;
}

/**
 * Checks if file is open in VSCode editor
 * @param {string} path Path to file
 * @returns {boolean}
 */
async function isFileOpen(path) {
  // TODO: Probably not possible
  await new Promise(resolve => setTimeout(resolve, 10000));
  return true;
}

async function getTerminalOutput() {
  const pathToTerminalLogs = join(ROOT, '.logs/.terminal-out.log');
  const terminalLogs = await readFile(pathToTerminalLogs, 'utf8');

  if (!terminalLogs) {
    throw new Error('No terminal logs found');
  }

  return terminalLogs;
}

/**
 * Returns the output of a command called from a given path
 * @param {string} command
 * @param {string} path Path relative to root
 * @returns {{stdout, stderr}}
 */
async function getCommandOutput(command, path = '') {
  const cmdOut = await execute(command, {
    cwd: join(ROOT, path),
    shell: '/bin/bash'
  });
  return cmdOut;
}

/**
 * TODO
 */
async function getLastCommand(howManyBack = 0) {
  const pathToBashLogs = join(ROOT, '.logs/.bash_history.log');
  const bashLogs = await readFile(pathToBashLogs, 'utf8');

  if (!bashLogs) {
    throw new Error(`Could not find ${pathToBashLogs}`);
  }

  const logs = bashLogs.split('\n');
  const lastLog = logs[logs.length - howManyBack - 2];

  return lastLog;
}

// TODO: Do not return whole file
async function getCWD() {
  const pathToCWD = join(ROOT, '.logs/.cwd.log');
  const cwd = await readFile(pathToCWD, 'utf8');
  return cwd;
}

async function getFile(path) {
  const file = await readFile(join(ROOT, path), 'utf8');
  return file;
}

async function fileExists(path) {
  return fs.existsSync(join(ROOT, path));
}

async function copyDirectory(folderToCopyPath, destinationFolderPath) {
  const folderToCopy = join(ROOT, folderToCopyPath);
  const destinationFolder = join(ROOT, destinationFolderPath);

  if (!fs.existsSync(destinationFolder)) {
    fs.mkdirSync(destinationFolder);
  }

  fs.readdirSync(folderToCopy).forEach(file => {
    fs.copyFileSync(`${folderToCopy}/${file}`, `${destinationFolder}/${file}`);
  });
}

async function copyProjectFiles(projectFolderPath, testsFolderPath, arrayOfFiles = []) {
  const projectFolder = join(ROOT, projectFolderPath);
  const testsFolder = join(ROOT, testsFolderPath);

  if (!projectFolder || !testsFolder || arrayOfFiles.length === 0) {
    throw Error('Cannot copy project files');
  }

  arrayOfFiles.forEach(file => {
    fs.copyFileSync(`${projectFolder}/${file}`, `${testsFolder}/${file}`);
  });
}

async function runCommand(command, path) {
  execSync(command, {
    cwd: join(ROOT, path),
    shell: '/bin/bash'
  });
}

async function getJsonFile(filePath) {
  const fileString = fs.readFileSync(join(ROOT, filePath));
  return JSON.parse(fileString);
}

async function writeJsonFile(path, content) {
  fs.writeFileSync(join(ROOT, path), JSON.stringify(content, null, 2));
}

async function generateHash(content) {
  const hash = sha256(content).toString();
  return hash;
}

async function generateSignature(privateKey, content) {
  const keyPair = ec.keyFromPrivate(privateKey, 'hex');
  const signature = keyPair.sign(content).toDER('hex');
  return signature;
}

async function validateSignature(publicKey, content, signature) {
  const keyPair = ec.keyFromPublic(publicKey, 'hex');
  const verifiedSignature = keyPair.verify(content, signature);
  return verifiedSignature;
}

async function getPublicKeyFromPrivate(privateKey) {
  const keyPair = ec.keyFromPrivate(privateKey, 'hex');
  const publicKey = keyPair.getPublic('hex');
  return publicKey;
}

// used in fundraising contract project
async function getContract(contractAddress, cwd, includePool = true) {
  // get the latest contract state from the blockchain
  const blockchain = await getJsonFile(`${cwd}/blockchain.json`);
  const latestContract = blockchain.reduce((currentContract, nextBlock) => {
    if (nextBlock.smartContracts) {
      nextBlock.smartContracts.forEach(contract => {
        if (contract.address === contractAddress) {
          // first occurrence of contract
          if (!currentContract.hasOwnProperty('address')) {
            Object.keys(contract).forEach(
              key => (currentContract[key] = contract[key])
            );

            // contract found and added, only update state after that
          } else if (contract.hasOwnProperty('state')) {
            currentContract.state = contract.state;
          }
        }
      });
    }
    return currentContract;
  }, {});

  if (includePool) {
    // add contract pool to latest contract state
    const smartContracts = await getJsonFile(`${cwd}/smart-contracts.json`);
    smartContracts.forEach(contract => {
      if (contract.address === contractAddress) {
        if (!latestContract.hasOwnProperty('address')) {
          Object.keys(contract).forEach(
            key => (latestContract[key] = contract[key])
          );
        } else if (latestContract.hasOwnProperty('state')) {
          latestContract.state = contract.state;
        }
      }
    });
  }

  return latestContract.hasOwnProperty('address') ? latestContract : null;
}

// for p2p network project
async function canConnectToSocket(address) {
  return await new Promise(resolve => {
    const socket = new WebSocket(address, { shouldKeepAlive: false });
    socket.on('open', () => {
      socket.close();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function startSocketServerAndHandshake({
  myPort: port,
  theirAddress = 'ws://localhost:4001',
  connectOnly = false
}) {
  return await new Promise(resolve => {
    const address = `ws://localhost:${port}`;

    const server = new WebSocketServer({ port });
    server.on('connection', externalSocket => {
      if (connectOnly) {
        externalSocket.close();
        server.close();
        resolve(true);
      }

      externalSocket.on('message', messageString => {
        const message = JSON.parse(messageString);

        if (message.hasOwnProperty('type') && message.type === 'HANDSHAKE') {
          externalSocket.close();
          server.close();
          resolve(message);
        } else {
          externalSocket.close();
          server.close();
        }
      });
    });

    setTimeout(() => {
      server.close();
      resolve();
    }, 5000);

    server.on('error', () => server.close());

    const socket = new WebSocket(theirAddress, { shouldKeepAlive: false });
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'HANDSHAKE', data: [address] }));
      socket.close();
    });

    socket.on('error', () => resolve());
  });
}

const __helpers = {
  getDirectory,
  isFileOpen,
  getFile,
  fileExists,
  getTerminalOutput,
  getCommandOutput,
  getLastCommand,
  getCWD,
  copyDirectory,
  copyProjectFiles,
  runCommand,
  getJsonFile,
  writeJsonFile,
  generateHash,
  generateSignature,
  validateSignature,
  getPublicKeyFromPrivate,
  getContract,
  canConnectToSocket,
  startSocketServerAndHandshake
};

export default __helpers;
