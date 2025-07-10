document.addEventListener("DOMContentLoaded", function () {
    console.log("DOMContentLoaded fired.");

    trackPageView();

    let nearestEventClickListener = null;

    updateNearestEvent();

    if (document.getElementById('calendar')) {
        console.log("Calendar element found. Initializing FullCalendar...");
        fetch('/api/events')
            .then(response => {
                console.log("API events fetch response:", response);
                if (!response.ok) {
                    throw new Error('Network response was not ok: ' + response.statusText);
                }
                return response.json();
            })
            .then(data => {
                console.log("API events data received for FullCalendar:", data);
                const events = data.events.map(event => ({
                    id: event.id,
                    title: event.description,
                    start: moment.tz(event.date, 'Europe/Kiev').format('YYYY-MM-DDTHH:mm:ss'),
                    url: event.url
                }));
                console.log("Processed events for FullCalendar:", events);

                const urlParams = new URLSearchParams(window.location.search);
                const highlightId = urlParams.get('highlightEvent');
                console.log("Highlight event ID from URL:", highlightId);

                $('#calendar').fullCalendar({
                    timeZone: 'Europe/Kiev',
                    header: {
                        left: 'prev,next today',
                        center: 'title',
                        right: 'month'
                    },
                    editable: false,
                    firstDay: 1,
                    events: events,
                    eventColor: '#3c5ca8',
                    eventTextColor: 'rgb(221, 221, 221)',
                    timeFormat: ' ',

                    dayRender: function (date, cell) {
                        if (moment().isSame(date, 'day')) {
                            cell.css({
                                'background-color': 'rgb(230, 230, 230)'
                            });
                        }
                    },
                    eventRender: function (event, element) {
                        const now = moment().tz('Europe/Kiev').startOf('day');
                        const eventStart = moment(event.start).tz('Europe/Kiev').startOf('day');

                        if (eventStart.isBefore(now)) {
                            element.addClass('past-event');
                        }

                        if (highlightId && event.id == highlightId) {
                            element.addClass('highlighted-event');
                            console.log(`!!! EVENT HIGHLIGHTED: ${event.title} (ID: ${event.id})`);
                        }
                    },
                    eventClick: function (events, jsEvent, view) {
                        if (events.url) {
                            jsEvent.preventDefault();
                            window.open(events.url, '_blank');
                            console.log(`Navigating to event URL in a new tab: ${events.url}`);
                        } else {
                            console.warn(`Для '${events.title}' (ID: ${events.id}) не знайдено URL.`);
                        }
                    }
                });

                if (highlightId) {
                    const targetEvent = events.find(e => e.id == highlightId);
                    if (targetEvent) {
                        console.log("Target event for scrolling found:", targetEvent);
                        $('#calendar').fullCalendar('gotoDate', moment(targetEvent.start));
                        setTimeout(() => {
                            const highlightedEventElement = $('.highlighted-event');
                            if (highlightedEventElement.length) {
                                highlightedEventElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                                console.log("Scrolled to highlighted event element.");
                            } else {
                                console.log("Highlighted event element NOT found after timeout. Possible render issue or class not applied.");
                            }
                        }, 800);
                    } else {
                        console.log("Target event NOT found in events array for highlightId:", highlightId);
                    }
                } else {
                    console.log("No highlightEvent parameter in URL for calendar init.");
                }

            })
            .catch(error => {
                console.error('Error fetching events for calendar:', error);
            });
    }

    function updateNearestEvent() {
        console.log("updateNearestEvent called.");
        fetch('/api/events')
            .then(response => {
                console.log("Nearest event API response:", response);
                if (!response.ok) {
                    throw new Error('Network response was not ok: ' + response.statusText);
                }
                return response.json();
            })
            .then(data => {
                console.log("Nearest event API data for strip:", data);
                const events = data.events.map(event => ({
                    id: event.id,
                    title: event.description,
                    start: moment.tz(event.date, 'Europe/Kiev').format('YYYY-MM-DDTHH:mm:ss'),
                    url: event.url
                }));
                console.log("All events from API for nearest:", events);

                const now = moment().tz('Europe/Kiev').startOf('day');
                const upcomingEvents = events.filter(event => moment(event.start).tz('Europe/Kiev').startOf('day').isSameOrAfter(now));
                console.log("Upcoming events:", upcomingEvents);

                const nearestEvent = upcomingEvents.reduce((prev, curr) => {
                    const currStart = moment(curr.start);
                    const prevStart = prev ? moment(prev.start) : null;

                    if (!prev || currStart.isBefore(prevStart)) {
                        return curr;
                    }
                    return prev;
                }, null);
                console.log("Nearest event found:", nearestEvent);

                const upcomingEventStrip = document.getElementById('upcoming-event-strip');
                const eventTitle = document.getElementById('event-title');
                const eventDate = document.getElementById('event-date');
                const simgridButton = upcomingEventStrip ? upcomingEventStrip.querySelector('.simgrid-button') : null;

                if (eventTitle && eventDate) {
                    if (nearestEvent) {
                        eventTitle.textContent = nearestEvent.title;
                        eventDate.textContent = moment(nearestEvent.start).format('DD MMM');
                        console.log("Upcoming event strip updated with event data.");

                        if (simgridButton) {
                            if (nearestEvent.url) {
                                simgridButton.href = nearestEvent.url;
                                simgridButton.style.display = '';
                                simgridButton.target = '_blank';
                                console.log(`SimGrid button URL updated to: ${nearestEvent.url}`);
                            } else {
                                simgridButton.href = '#';
                                simgridButton.style.display = 'none';
                                console.warn(`URL для '${nearestEvent.title}' (ID: ${nearestEvent.id}) не знайдено. Приховую кнопку.`);
                            }
                        }

                        if (eventTitle) {
                            if (nearestEventClickListener) {
                                eventTitle.removeEventListener('click', nearestEventClickListener);
                            }
                            nearestEventClickListener = function () {
                                window.location.href = `/calendar?highlightEvent=${nearestEvent.id}`;
                                console.log(`Navigating to: /calendar?highlightEvent=${nearestEvent.id}`);
                            };
                            eventTitle.addEventListener('click', nearestEventClickListener);
                            console.log("Added new event click listener for title.");
                        }

                    } else {
                        eventTitle.textContent = "Наразі немає майбутніх подій";
                        eventDate.textContent = "";
                        console.log("No nearest event found. Displaying default message.");

                        if (simgridButton) {
                            simgridButton.href = '#';
                            simgridButton.style.display = 'none';
                            console.log("SimGrid button hidden as there are no upcoming events.");
                        }
                    }

                    if (upcomingEventStrip) {
                        upcomingEventStrip.style.display = 'flex';
                    }
                } else {
                    console.error("HTML elements for upcoming event strip not found!");
                }
            })
            .catch(error => {
                console.error('Error fetching nearest event:', error);
                if (document.getElementById('event-title')) {
                    document.getElementById('event-title').textContent = "Помилка завантаження подій";
                }
                if (document.getElementById('event-date')) {
                    document.getElementById('event-date').textContent = "";
                }
                if (document.getElementById('upcoming-event-strip')) {
                    document.getElementById('upcoming-event-strip').style.display = 'none';
                }
                console.log("Error occurred. Upcoming event strip hidden.");
            });
    }
});

function trackPageView() {
    fetch('/track-view', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
    })
    .then(response => {
        if (!response.ok) {
            console.error('Failed to track page view');
        } else {
            console.log('Page view tracked successfully');
        }
    })
    .catch(error => {
        console.error('Error sending tracking data:', error);
    });
}