const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const os = require('os');
require('dotenv').config();

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// Hosts like Render sit behind a proxy; this lets secure cookies work there.
if (isProduction) {
    app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction // true only when hosted over HTTPS
    }
}));

// Keep the image in memory, then store it in MongoDB.
// Hosted disks are wiped on restart, so files must not be saved locally.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 2 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const allowedExtensions = ['.jpg', '.jpeg', '.png'];
        const allowedMimeTypes = ['image/jpeg', 'image/png'];

        if (
            allowedExtensions.includes(extension) &&
            allowedMimeTypes.includes(file.mimetype)
        ) {
            cb(null, true);
        } else {
            cb(new Error('Only JPG, JPEG, and PNG images are allowed.'));
        }
    }
});

const client = new MongoClient(process.env.MONGO_URI);

let users;
let avatars;

app.get('/', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

// Serves a profile picture stored in MongoDB.
app.get('/avatar/:id', async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            return res.sendStatus(404);
        }

        const avatar = await avatars.findOne({ _id: new ObjectId(req.params.id) });

        if (!avatar) {
            return res.sendStatus(404);
        }

        res.set({
            'Content-Type': avatar.contentType,
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff'
        });

        res.send(avatar.data.buffer);
    } catch (error) {
        console.error(error);
        res.sendStatus(500);
    }
});

app.post('/register', (req, res) => {
    upload.single('profilePicture')(req, res, async (uploadError) => {
        if (uploadError) {
            const message = uploadError.code === 'LIMIT_FILE_SIZE'
                ? 'Image must be smaller than 2 MB.'
                : uploadError.message;

            return res.status(400).render('register', {
                error: message
            });
        }

        if (!req.file) {
            return res.status(400).render('register', {
                error: 'Please select a profile picture.'
            });
        }

        try {
            const name = (req.body.name || '').trim();
            const email = (req.body.email || '').trim().toLowerCase();
            const password = req.body.password || '';

            if (!name || !email || password.length < 8) {
                return res.status(400).render('register', {
                    error: 'Enter your name, email, and a password of at least 8 characters.'
                });
            }

            const existingUser = await users.findOne({ email });

            if (existingUser) {
                return res.status(409).render('register', {
                    error: 'Email is already registered.'
                });
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            const avatarId = new ObjectId();

            // Insert the user first: the unique email index protects against duplicates.
            const result = await users.insertOne({
                name,
                email,
                password: hashedPassword,
                profilePicture: '/avatar/' + avatarId,
                createdAt: new Date()
            });

            try {
                await avatars.insertOne({
                    _id: avatarId,
                    data: req.file.buffer,
                    contentType: req.file.mimetype,
                    createdAt: new Date()
                });
            } catch (avatarError) {
                // Don't leave a user whose picture failed to save.
                await users.deleteOne({ _id: result.insertedId });
                throw avatarError;
            }

            res.redirect('/login');
        } catch (error) {
            console.error(error);

            if (error.code === 11000) {
                return res.status(409).render('register', {
                    error: 'Email is already registered.'
                });
            }

            res.status(500).render('register', {
                error: 'Registration failed. Please try again.'
            });
        }
    });
});

app.post('/login', async (req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const password = req.body.password || '';

        const user = await users.findOne({ email });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).render('login', {
                error: 'Invalid credentials! Please check your email and password.'
            });
        }

        req.session.userId = user._id.toString();

        req.session.save((error) => {
            if (error) {
                console.error(error);
                return res.status(500).send('Unable to create session.');
            }

            res.redirect('/home');
        });
    } catch (error) {
        console.error(error);

        res.status(500).render('login', {
            error: 'Login failed. Please try again.'
        });
    }
});

app.get('/home', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const user = await users.findOne({
            _id: new ObjectId(req.session.userId)
        });

        if (!user) {
            return req.session.destroy(() => res.redirect('/login'));
        }

        res.render('home', {
            name: user.name,
            profilePicture: user.profilePicture
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Unable to load home page.');
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).send('Logout failed.');
        }

        res.redirect('/login');
    });
});

async function startServer() {
    try {
        if (!process.env.MONGO_URI || !process.env.SESSION_SECRET) {
            throw new Error('Configure MONGO_URI and SESSION_SECRET in .env.');
        }

        await client.connect();

        const db = client.db('loginDB');
        users = db.collection('users');
        avatars = db.collection('avatars');

        await users.createIndex({ email: 1 }, { unique: true });

        // Hosts assign the port; 0.0.0.0 lets your phone reach it on the same Wi-Fi.
        const PORT = process.env.PORT || 3000;

        app.listen(PORT, '0.0.0.0', () => {
            console.log('MongoDB Atlas connected!');
            console.log(`Computer: http://localhost:${PORT}`);

            // Print the address to open on your phone (same Wi-Fi).
            for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
                for (const a of addrs) {
                    if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
                        console.log(`Phone (${name}): http://${a.address}:${PORT}/login`);
                    }
                }
            }
        });
    } catch (error) {
        console.error('Startup failed:', error.message);
        await client.close().catch(() => {});
        process.exit(1);
    }
}

startServer();