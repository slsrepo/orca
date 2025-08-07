function generatePin(config, logger = console) {
    let pin = config && config.bridge && config.bridge.pin;
    if (!pin) {
        const randomPin = Math.floor(10000000 + Math.random() * 90000000).toString();
        pin = `${randomPin.substring(0, 3)}-${randomPin.substring(3, 5)}-${randomPin.substring(5, 8)}`;
        if (logger && logger.warn) {
            logger.warn(`No PIN found in config, generated random PIN: ${pin}. Store this securely!`);
        }
    }
    return pin;
}
module.exports = generatePin;
