const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const port = 3000;

app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect('mongodb+srv://deb2dev:demo123@cluster0.5c83l.mongodb.net/dlsapi?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log("Connected to MongoDB"))
    .catch((error) => console.error("MongoDB connection error:", error));

// Schema and Model
const trackingSchema = new mongoose.Schema({
    ShipmentID: String,
    ProgramID: Number,
    ProgramName: String,
    OrderNumber: String,
    SerialNumber: String,
    LocationID: String,
    ProductID: String,
    SensorType: String
});

const Tracking = mongoose.model('Tracking', trackingSchema);

// Puppeteer function to monitor network requests
const monitorNetworkRequests = async (url) => {
    const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true});
    const page = await browser.newPage();

    let recordedUrl = null;

    page.on('request', (request) => {
        const requestUrl = request.url();
        if (requestUrl.includes("locationID") || requestUrl.includes("productID")) {
            recordedUrl = requestUrl;
            page.removeAllListeners('request');
        }
    });

    await page.goto(url);

    let extractedItems = {};
    if (recordedUrl) {
        extractedItems = new URLSearchParams(new URL(recordedUrl).search);
    }

    await browser.close();
    return extractedItems;
};

// Function to fetch tracking data from MongoDB or API
const fetchData = async (serialNumber) => {
    const existingTracking = await Tracking.findOne({ SerialNumber: serialNumber });

    if (existingTracking) {
        return existingTracking;
    } else {
        try {
            const shipmentResponse = await axios.get(`https://tracks.sensitechccv.com/Sensitech.Web/api/PublicShipment?serialNumber=${serialNumber}`);
            const shipmentData = shipmentResponse.data.Data.publicShipmentInfoList;

            if (shipmentData && shipmentData.length > 0) {
                const shipmentInfo = shipmentData[0];
                const extractedData = {
                    ShipmentID: shipmentInfo.ShipmentID,
                    ProgramID: shipmentInfo.ProgramID,
                    ProgramName: shipmentInfo.ProgramName,
                    OrderNumber: shipmentInfo.OrderNumber,
                    SerialNumber: serialNumber,
                    LocationID: null,
                    ProductID: null,
                    SensorType: "sensitech"
                };

                const baseUrl = 'https://tracks.sensitechccv.com/Sensitech.Web/PublicShipment/TripDetail/';
                const queryString = `${extractedData.ShipmentID}?SerialNumber=${extractedData.SerialNumber}&ProgramID=${extractedData.ProgramID}&OrderNumber=${extractedData.OrderNumber}`;

                const otherTrackingDetails = await monitorNetworkRequests(baseUrl + queryString);
                extractedData.LocationID = otherTrackingDetails.get('locationID');
                extractedData.ProductID = otherTrackingDetails.get('productID');

                const newTracking = new Tracking(extractedData);
                await newTracking.save();

                return newTracking;
            }
        } catch (error) {
            console.error('Error fetching data:', error);
            return null;
        }
    }
};

// Function to get temperature data
const getTemperatureData = async (trackingData) => {
    try {
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const tempUrl = `https://tracks.sensitechccv.com/Sensitech.Web/api/PublicShipment`;
        const tempQueryString = `?locationID=${trackingData.LocationID}&productID=${trackingData.ProductID}&shipmentID=${trackingData.ShipmentID}&incrementalStartTime=&dataType=TEMPERATURE&serialNumber=${trackingData.SerialNumber}&tempUnitId=1&currentTimeZoneId=Pacific%20Standard%20Time&_=${currentTimestamp}`;

        const fullUrl = tempUrl + tempQueryString;
        //console.log(`Requesting temperature data from: ${fullUrl}`);

        const tempResponse = await axios.get(fullUrl);

        // Log response status and data for debugging
        //console.log(`Temperature API Response Status: ${tempResponse.status}`);
        //console.log('Temperature API Response Data:', tempResponse.data);

        const datapoints = tempResponse.data.datapoint;

        if (datapoints && datapoints.length > 0) {
            const lastDataPoint = datapoints[datapoints.length - 1];
            return {
                current: lastDataPoint.TemperatureExternal || null,
                low: tempResponse.data.low || null,
                high: tempResponse.data.high || null,
                ideal: tempResponse.data.ideal || null,
                sensor: trackingData.SensorType
            };
        } else {
            //console.warn('No temperature datapoints found in the response');
            return { current: null, low: null, high: null, ideal: null , sensor: null};
        }
    } catch (error) {
        //console.error('Error fetching temperature data:', error.message);
        if (error.response) {
            console.error('Response Status:', error.response.status);
            console.error('Response Data:', error.response.data);
        }
        return { current: null, low: null, high: null, ideal: null, sensor: null};
    }
};

// get temp luxcross
const getTemperatureluxData = async (trackingData) => {
    const trackerID = { TrackerId: trackingData.SerialNumber };

    try {
        const getluxLocdata = await axios.post('https://oversightapi.locustraxx.com/api/uoversight/GetTrackerStateList', trackerID);

        const luxTrackData = getluxLocdata.data;

        if (luxTrackData && luxTrackData.TrackerStatusList && luxTrackData.TrackerStatusList.length > 0) {
            const lastDataPoint = luxTrackData.TrackerStatusList[0];
            const temperatureString = lastDataPoint.Temperature;

            // Properly convert temperatureString to a number
            const currentTemperature = temperatureString;

            return {
                current: currentTemperature || null,
                low: lastDataPoint.LowTemperature || null, // Assuming these are available
                high: lastDataPoint.HighTemperature || null,
                ideal: lastDataPoint.IdealTemperature || null,
                sensor: trackingData.SensorType
            };
        } else {
            console.warn('No temperature datapoints found in the response');
            return { current: null, low: null, high: null, ideal: null, sensor: null };
        }

    } catch (error) {
        console.error('Error fetching temperature data:', error.message);
        if (error.response) {
            console.error('Response Status:', error.response.status);
            console.error('Response Data:', error.response.data);
        }
        return { current: null, low: null, high: null, ideal: null, sensor: null };
    }
};


// get sensorInfo
const sensorInfo = async (serialNumber) => {
    try {
        const existingTrackingSensor = await Tracking.findOne({ SerialNumber: serialNumber });

        if (existingTrackingSensor) {
            return existingTrackingSensor.SensorType;
        } else {
            return null;
        }
    } catch (error) {
        console.error(`Error fetching sensor info for SerialNumber ${serialNumber}:`, error);
        return null;
    }
};


// get luxcross data
const luxcrossData = async (serialNumber) => {
    const existingTracking = await Tracking.findOne({ SerialNumber: serialNumber });

    if (existingTracking) {
        return existingTracking;
    } else {
        try {
                const trackerID = { TrackerId : serialNumber }
                const getluxdata = await axios.post('https://oversightapi.locustraxx.com/api/uoversight/GetTrackerStateList' , trackerID);

                const luxAllData = getluxdata.data;
                
                const luxTrackData = luxAllData.TrackerStatusList[0]
                //console.log(JSON.stringify(luxTrackData));
                if(luxTrackData){
                    const extractedData = {
                        ShipmentID: luxTrackData.TrackerStateGuid,
                        ProgramID: luxAllData.Customer.CustomerId,
                        ProgramName: luxAllData.Customer.WebsiteId,
                        OrderNumber: luxTrackData.ModelNumber,
                        SerialNumber: serialNumber,
                        LocationID: luxTrackData.CustomerTrackerId,
                        ProductID: luxTrackData.ModelNumber,
                        SensorType: "luxcross"
                    };
                    //console.log(JSON.stringify(luxTrackData));
                    const newTracking = new Tracking(extractedData);
                    await newTracking.save();

                    return newTracking;
                }
            

        } catch (error) {
            console.error('Error fetching data:', error);
            return null;
        }

    } 
};

// Function to get location data
const getLocationData = async (trackingData) => {
    try {
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const locUrl = `https://tracks.sensitechccv.com/Sensitech.Web/api/PublicShipment`;
        const locQueryString = `?locationID=${trackingData.LocationID}&productID=${trackingData.ProductID}&shipmentID=${trackingData.ShipmentID}&incrementalStartTime=&dataType=LOCATION&serialNumber=${trackingData.SerialNumber}&tempUnitId=1&currentTimeZoneId=Pcaific%20Standard%20Time&_=${currentTimestamp}`;

        const locResponse = await axios.get(locUrl + locQueryString);
        const datapoints = locResponse.data.datapoint;

        if (datapoints && datapoints.length > 0) {
            const lastDataPoint = datapoints[datapoints.length - 1];
            return {
                long: lastDataPoint.Longitude || null,
                lat: lastDataPoint.Latitude || null
            };
        }
    } catch (error) {
        console.error('Error fetching location data:', error);
    }
    return { long: null, lat: null };
};

// get temp luxcross
const getLocationluxData = async (trackingData) => {

    const trackerID = { TrackerId : trackingData.SerialNumber }

    try {
        const getluxLocdata = await axios.post('https://oversightapi.locustraxx.com/api/uoversight/GetTrackerStateList' , 
            trackerID)

        const luxTrackData = getluxLocdata.data;
        if (luxTrackData) {
            const lastDataPoint = luxTrackData.TrackerStatusList[0];
            return {
                long: lastDataPoint.Longitude || null,
                lat: lastDataPoint.Latitude || null
            };
        } else {
            return { long: null, lat: null };
        }

    } catch (error) {
        console.error('Error fetching location data:', error);
    }
    return { long: null, lat: null };
};

// Endpoint to handle polling updates
app.post('/api/updates', async (req, res) => {
    const { serialNumber, sensorType } = req.body;

    if (!serialNumber) {
        return res.status(400).json({ error: 'SerialNumber is missing' });
    }

    try {
        // Determine the sensor type, either from database or request body
        let sensor_type = await sensorInfo(serialNumber);
        if (!sensor_type) {
            sensor_type = sensorType;
        }

        let trackingData;
        let tempData;
        let locationData;

        if (sensor_type === 'sensitech') {
            trackingData = await fetchData(serialNumber);
            if (!trackingData) {
                return res.status(404).json({ error: 'Tracking data not found for Sensitech' });
            }
            tempData = await getTemperatureData(trackingData);
            locationData = await getLocationData(trackingData);

        } else if (sensor_type === 'luxcross') {
            trackingData = await luxcrossData(serialNumber);
            if (!trackingData) {
                return res.status(404).json({ error: 'Tracking data not found for Luxcross' });
            }
            tempData = await getTemperatureluxData(trackingData);
            locationData = await getLocationluxData(trackingData);

        } else {
            return res.status(404).json({ error: 'Invalid sensor type' });
        }

        // Combine the tracking, temperature, and location data
        const updatedData = {
            trackingData,
            tempDetails: tempData,
            currentLocation: locationData
        };

        res.status(200).json({ status: 'Success', data: updatedData });
    } catch (error) {
        console.error('Error during polling update:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Endpoint to fetch all serial numbers on page load
app.get('/api/serialNumbers', async (req, res) => {
    try {
        const trackingData = await Tracking.find({}, 'SerialNumber').exec();
        const serialNumbers = trackingData.map(data => data.SerialNumber);
        res.status(200).json({ serialNumbers });
    } catch (error) {
        console.error('Error fetching serial numbers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to handle deletion of a tracking record
app.delete('/api/delete', async (req, res) => {
    const { serialNumber } = req.body;

    if (!serialNumber) {
        return res.status(400).json({ error: 'SerialNumber is required' });
    }

    try {
        const result = await Tracking.deleteOne({ SerialNumber: serialNumber });

        if (result.deletedCount > 0) {
            res.status(200).json({ status: 'Success', message: 'Record deleted successfully' });
        } else {
            res.status(404).json({ status: 'Error', message: 'Record not found' });
        }
    } catch (error) {
        console.error('Error deleting record:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start the server
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
