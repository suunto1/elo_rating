document.addEventListener("DOMContentLoaded", function() {
    updateNearestEvent();

    if (document.getElementById('calendar')) {
        fetch('/api/events')
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(data => {
                const events = data.events.map(event => ({
                    title: event.description,
                    start: moment.tz(event.date, 'Europe/Kiev').format('YYYY-MM-DDTHH:mm:ss')
                }));

                $('#calendar').fullCalendar({
                    timeZone: 'Europe/Kiev',
                    header: {
                        left: 'prev,next today',
                        center: 'title',
                        right: 'month'
                    },
                    editable: false,
                    firstDay: 1,
                    events: events
                });

                setActiveMenuItem();
            })
            .catch(error => {
                console.error('Error fetching events:', error);
            });
    }

    function updateNearestEvent() {
        fetch('/api/events')
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(data => {
                const events = data.events.map(event => ({
                    title: event.description,
                    start: moment.tz(event.date, 'Europe/Kiev').format('YYYY-MM-DDTHH:mm:ss')
                }));

                const now = moment();
                const nearestEvent = events.reduce((prev, curr) => {
                    return moment(curr.start).isAfter(now) && (!prev || moment(curr.start).isBefore(prev.start)) ? curr : prev;
                }, null);

                if (nearestEvent) {
                    document.getElementById('event-title').textContent = nearestEvent.title;
                    document.getElementById('event-date').textContent = moment(nearestEvent.start).format('DD MMM YYYY');
                } else {
                    document.getElementById('event-title').textContent = "No upcoming events";
                    document.getElementById('event-date').textContent = "";
                }
            })
            .catch(error => {
                console.error('Error fetching events:', error);
                document.getElementById('event-title').textContent = "Error loading events";
            });
    }

    function setActiveMenuItem() {
        const currentUrl = window.location.pathname;
        const menuItems = document.querySelectorAll('.menu a');
        menuItems.forEach(function(item) {
            if (item.getAttribute('href') === currentUrl) {
                item.classList.add('active');
            }
        });
    }
});
